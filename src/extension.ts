import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnalysisResult, AnalyzerSkip, Conflict, ConflictAnalyzer } from './analyzer';
import { ConflictDecorations } from './decorations';
import { ConflictDiagnostics, LineSource, linesOfDocument, linesOfText } from './diagnostics';
import { conflictLines, conflictTasks } from './format';
import { git, tryGit } from './git';
import { ConflictHoverProvider } from './hoverProvider';
import { DEFAULT_TASK_PATTERN } from './taskResolver';

const CONFIG = 'gitConflictRadar';
const MAIN_SCHEME = 'gcr-main';
const TYPING_DELAY_MS = 500;
const MAX_LINES = 50_000;
const MAX_SCAN_FILES = 300;
const MIN_REMOTE_CHECK_SECONDS = 5;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new RadarController(context));
}

export function deactivate(): void {}

function config() {
  const c = vscode.workspace.getConfiguration(CONFIG);
  return {
    enabled: c.get<boolean>('enabled', true),
    mainBranch: c.get<string>('mainBranch', 'origin/main'),
    taskPattern: c.get<string>('taskPattern', DEFAULT_TASK_PATTERN),
    taskUrlTemplate: c.get<string>('taskUrlTemplate', ''),
    remoteCheckSeconds: c.get<number>('remoteCheckSeconds', 60),
    showNotifications: c.get<boolean>('showNotifications', true),
  };
}

interface Entry {
  uri: vscode.Uri;
  result: AnalysisResult;
  lineCount: number;
}

type ScanReason = 'startup' | 'refs' | 'save' | 'manual';

class RadarController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly analyzer = new ConflictAnalyzer(() => config());
  private readonly decorations: ConflictDecorations;
  private readonly diagnostics = new ConflictDiagnostics();
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly output = vscode.window.createOutputChannel('Git Conflict Radar');

  /** Tüm dosyaların sonuçları (açık olsun olmasın), uri → sonuç. */
  private readonly entries = new Map<string, Entry>();
  private readonly skipReasons = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly runIds = new Map<string, number>();
  /** Bildirimi gösterilmiş çakışmalar; aynı çakışma için ikinci kez bildirim çıkmaz. */
  private readonly notified = new Set<string>();
  /** Kök → son görülen main SHA'sı; değiştiyse "main'e yeni değişiklik geldi" denir. */
  private readonly lastMainSha = new Map<string, string>();
  private readonly scanning = new Map<string, { pending?: ScanReason }>();
  private scanTimer: NodeJS.Timeout | undefined;
  private scanReason: ScanReason = 'refs';
  private remoteTimer: NodeJS.Timeout | undefined;
  private checkingRemote = false;

  constructor(context: vscode.ExtensionContext) {
    this.decorations = new ConflictDecorations(context);
    this.statusBar.command = 'gitConflictRadar.showConflicts';

    this.disposables.push(
      this.decorations,
      this.diagnostics,
      this.statusBar,
      this.output,
      vscode.languages.registerHoverProvider(
        { scheme: 'file' },
        new ConflictHoverProvider((uri) => this.entries.get(uri.toString())?.result, () => config().taskUrlTemplate),
      ),
      vscode.workspace.registerTextDocumentContentProvider(MAIN_SCHEME, {
        provideTextDocumentContent: (uri) => this.provideMainContent(uri),
      }),
      vscode.commands.registerCommand('gitConflictRadar.refresh', () => this.refreshAll('manual')),
      vscode.commands.registerCommand('gitConflictRadar.fetchMain', () => this.fetchMain()),
      vscode.commands.registerCommand('gitConflictRadar.openDiffWithMain', (uri?: string) => this.openDiff(uri)),
      vscode.commands.registerCommand('gitConflictRadar.nextConflict', () => this.nextConflict()),
      vscode.commands.registerCommand('gitConflictRadar.showConflicts', () => this.showConflicts()),
      vscode.commands.registerCommand('gitConflictRadar.toggle', () =>
        vscode.workspace
          .getConfiguration(CONFIG)
          .update('enabled', !config().enabled, vscode.ConfigurationTarget.Global),
      ),

      vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => this.showOrSchedule(e))),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.isVisible(e.document)) {
          this.schedule(e.document, TYPING_DELAY_MS);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.schedule(doc, 0);
        this.scheduleScan('save', 1500);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.onClose(doc)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleScan('startup', 0)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG)) {
          this.analyzer.clearAll();
          this.setupRemoteWatch();
          this.refreshAll('manual');
        }
      }),
    );

    // Dal değişimi, commit, fetch, pull gibi ref değişikliklerini izle.
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/.git/{HEAD,FETCH_HEAD,ORIG_HEAD,packed-refs,refs/**}',
    );
    const onRefs = () => this.scheduleScan('refs', 1000);
    this.disposables.push(watcher, watcher.onDidChange(onRefs), watcher.onDidCreate(onRefs), watcher.onDidDelete(onRefs));
    this.watchBuiltInGit();

    this.setupRemoteWatch();
    vscode.window.visibleTextEditors.forEach((e) => this.showOrSchedule(e));
    this.scheduleScan('startup', 0);
    this.updateStatusBar();
  }

  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    clearTimeout(this.scanTimer);
    clearInterval(this.remoteTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  // ---- Tek belge analizi (açık dosyalar, kaydedilmemiş içerik dahil) ----

  private isVisible(doc: vscode.TextDocument): boolean {
    return vscode.window.visibleTextEditors.some((e) => e.document === doc);
  }

  private showOrSchedule(editor: vscode.TextEditor): void {
    const entry = this.entries.get(editor.document.uri.toString());
    if (entry) {
      this.decorations.apply(editor, entry.result.conflicts, entry.result.refs.mainRef);
    }
    this.schedule(editor.document, entry ? TYPING_DELAY_MS : 0);
  }

  private schedule(doc: vscode.TextDocument, delay: number): void {
    if (doc.uri.scheme !== 'file') {
      return;
    }
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.runDocument(doc);
      }, delay),
    );
  }

  private async runDocument(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    const runId = this.nextRunId(key);

    if (!config().enabled || doc.isClosed) {
      return;
    }
    if (doc.lineCount > MAX_LINES) {
      this.setSkip(doc.uri, 'Dosya çok büyük');
      return;
    }
    try {
      const result = await this.analyzer.analyze(doc.uri.fsPath, doc.getText());
      if (this.runIds.get(key) !== runId || doc.isClosed) {
        return; // Bu arada daha yeni bir analiz başladı.
      }
      this.store(doc.uri, result, linesOfDocument(doc));
    } catch (err) {
      if (this.runIds.get(key) === runId) {
        this.handleError(doc.uri, err);
      }
    }
  }

  private nextRunId(key: string): number {
    const id = (this.runIds.get(key) ?? 0) + 1;
    this.runIds.set(key, id);
    return id;
  }

  private store(uri: vscode.Uri, result: AnalysisResult, lines: LineSource): void {
    const key = uri.toString();
    this.skipReasons.delete(key);
    if (result.conflicts.length === 0 && !this.openDocument(uri)) {
      this.entries.delete(key);
      this.diagnostics.delete(uri);
    } else {
      this.entries.set(key, { uri, result, lineCount: lines.lineCount });
      this.diagnostics.set(uri, lines, result);
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === key) {
        this.decorations.apply(editor, result.conflicts, result.refs.mainRef);
      }
    }
    this.updateStatusBar();
  }

  private handleError(uri: vscode.Uri, err: unknown): void {
    if (!(err instanceof AnalyzerSkip)) {
      this.output.appendLine(`[${new Date().toISOString()}] ${uri.fsPath}: ${String(err)}`);
    }
    this.setSkip(uri, err instanceof AnalyzerSkip ? err.message : 'Analiz hatası (Output > Git Conflict Radar)');
  }

  private setSkip(uri: vscode.Uri, reason: string): void {
    this.clearEntry(uri);
    this.skipReasons.set(uri.toString(), reason);
    this.updateStatusBar();
  }

  private clearEntry(uri: vscode.Uri): void {
    const key = uri.toString();
    this.entries.delete(key);
    this.skipReasons.delete(key);
    this.diagnostics.delete(uri);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === key) {
        this.decorations.clear(editor);
      }
    }
  }

  private onClose(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.runIds.delete(key);
    // Kapatılan dosyada kaydedilmemiş değişiklikler vardıysa sonuç artık geçersiz; diskteki haliyle yeniden tara.
    const entry = this.entries.get(key);
    if (entry) {
      this.clearEntry(doc.uri);
      this.scheduleScan('refs', 0);
    }
    this.updateStatusBar();
  }

  private openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  }

  // ---- Branch taraması (açık olmayan dosyalar dahil) ----

  private scheduleScan(reason: ScanReason, delay: number): void {
    // Birden fazla tetikleyici birleşirse en "önemli" nedeni koru.
    const rank: Record<ScanReason, number> = { save: 0, refs: 1, startup: 2, manual: 3 };
    if (!this.scanTimer || rank[reason] > rank[this.scanReason]) {
      this.scanReason = reason;
    }
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      const r = this.scanReason;
      this.scanReason = 'save';
      void this.scanAll(r);
    }, delay);
  }

  private async roots(): Promise<string[]> {
    const roots = new Set(this.analyzer.knownRoots());
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === 'file') {
        const root = await this.analyzer.findRootForDir(folder.uri.fsPath);
        if (root) {
          roots.add(root);
        }
      }
    }
    return [...roots];
  }

  private async scanAll(reason: ScanReason): Promise<void> {
    if (!config().enabled) {
      return;
    }
    if (reason !== 'save') {
      this.analyzer.invalidateRefs();
    }
    for (const root of await this.roots()) {
      await this.scanRoot(root, reason);
    }
  }

  private async scanRoot(root: string, reason: ScanReason): Promise<void> {
    const state = this.scanning.get(root);
    if (state) {
      state.pending = reason; // Tarama sürerken gelen istek bitince tekrar çalıştırılır.
      return;
    }
    this.scanning.set(root, {});
    try {
      await this.doScanRoot(root, reason);
    } catch (err) {
      if (!(err instanceof AnalyzerSkip)) {
        this.output.appendLine(`[${new Date().toISOString()}] tarama ${root}: ${String(err)}`);
      }
    } finally {
      const pending = this.scanning.get(root)?.pending;
      this.scanning.delete(root);
      if (pending) {
        void this.scanRoot(root, pending);
      }
    }
  }

  private async doScanRoot(root: string, reason: ScanReason): Promise<void> {
    const refs = await this.analyzer.getRefs(root);
    const previousMain = this.lastMainSha.get(root);
    this.lastMainSha.set(root, refs.mainSha);
    const mainMoved = previousMain !== undefined && previousMain !== refs.mainSha;

    const candidates = (await this.analyzer.candidateFiles(refs)).slice(0, MAX_SCAN_FILES);
    const displayRoot = this.displayRoot(root);
    const openByRealPath = new Map<string, vscode.TextDocument>();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file') {
        openByRealPath.set(realpath(doc.uri.fsPath), doc);
      }
    }

    const scanned = new Set<string>();
    const found: Entry[] = [];
    for (const rel of candidates) {
      const realFile = path.join(root, rel);
      const doc = openByRealPath.get(realFile);
      const uri = doc?.uri ?? vscode.Uri.file(path.join(displayRoot, rel));
      const key = uri.toString();
      scanned.add(key);

      let text: string;
      let lines: LineSource;
      if (doc) {
        text = doc.getText();
        lines = linesOfDocument(doc);
      } else {
        try {
          text = await fs.promises.readFile(realFile, 'utf8');
        } catch {
          continue; // Çalışma kopyasında silinmiş.
        }
        lines = linesOfText(text);
      }

      const runId = this.nextRunId(key);
      try {
        const result = await this.analyzer.analyze(realFile, text);
        if (this.runIds.get(key) !== runId) {
          continue; // Bu sırada belge kendi analizini yaptı; onunki daha güncel.
        }
        this.store(uri, result, lines);
        if (result.conflicts.length > 0) {
          found.push({ uri, result, lineCount: lines.lineCount });
        }
      } catch (err) {
        this.handleError(uri, err);
      }
    }

    // Artık aday olmayan (çakışması kalmamış) dosyaların eski uyarılarını temizle.
    for (const entry of [...this.entries.values()]) {
      const key = entry.uri.toString();
      if (entry.result.refs.root !== root || scanned.has(key)) {
        continue;
      }
      const doc = this.openDocument(entry.uri);
      if (doc) {
        this.schedule(doc, 0);
      } else {
        this.clearEntry(entry.uri);
      }
    }
    this.updateStatusBar();
    this.notifyBranch(found, mainMoved, reason);
  }

  /** git'in döndürdüğü gerçek yolu, kullanıcının açtığı klasörün yoluna çevirir (örn. macOS'ta /private/tmp → /tmp). */
  private displayRoot(root: string): string {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') {
        continue;
      }
      const shown = folder.uri.fsPath;
      const rel = path.relative(root, realpath(shown));
      if (rel === '') {
        return shown;
      }
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && shown.endsWith(path.sep + rel)) {
        return shown.slice(0, shown.length - rel.length - 1);
      }
    }
    return root;
  }

  private refreshAll(reason: ScanReason): void {
    this.analyzer.invalidateRefs();
    if (!config().enabled) {
      this.diagnostics.clear();
      vscode.window.visibleTextEditors.forEach((e) => this.decorations.clear(e));
      this.entries.clear();
      this.skipReasons.clear();
      this.updateStatusBar();
      return;
    }
    new Set(vscode.window.visibleTextEditors.map((e) => e.document)).forEach((d) => this.schedule(d, 0));
    this.scheduleScan(reason, 0);
  }

  /** Yerleşik Git eklentisi varsa HEAD değişimlerini oradan da dinle (FS watcher'ı kaçırdığı durumlar için). */
  private watchBuiltInGit(): void {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) {
      return;
    }
    const attach = (api: any) => {
      const heads = new Map<unknown, string | undefined>();
      const watchRepo = (repo: any) => {
        heads.set(repo, repo.state?.HEAD?.commit);
        this.disposables.push(
          repo.state.onDidChange(() => {
            const head = repo.state?.HEAD?.commit;
            if (heads.get(repo) !== head) {
              heads.set(repo, head);
              this.scheduleScan('refs', 1000);
            }
          }),
        );
      };
      (api.repositories ?? []).forEach(watchRepo);
      this.disposables.push(api.onDidOpenRepository(watchRepo));
    };
    Promise.resolve(ext.isActive ? ext.exports : ext.activate())
      .then((exports: any) => attach(exports.getAPI(1)))
      .catch(() => {
        // Git eklentisi kapalıysa sadece FS watcher kullanılır.
      });
  }

  // ---- Uzak main'i arka planda izleme ----

  private setupRemoteWatch(): void {
    clearInterval(this.remoteTimer);
    this.remoteTimer = undefined;
    const seconds = config().remoteCheckSeconds;
    if (config().enabled && seconds > 0) {
      const ms = Math.max(MIN_REMOTE_CHECK_SECONDS, seconds) * 1000;
      this.remoteTimer = setInterval(() => void this.checkRemotes(), ms);
      setTimeout(() => void this.checkRemotes(), 3000);
    }
  }

  /**
   * Uzaktaki main'in son commit'ini ucuz bir `git ls-remote` ile kontrol eder; değiştiyse (biri merge
   * yaptıysa) yalnızca o dalı fetch eder. Ref değişikliği tarama ve bildirimi tetikler.
   */
  private async checkRemotes(): Promise<void> {
    if (this.checkingRemote) {
      return;
    }
    this.checkingRemote = true;
    try {
      for (const root of await this.roots()) {
        try {
          const refs = await this.analyzer.getRefs(root);
          const rb = await this.analyzer.remoteBranch(refs);
          if (!rb) {
            continue; // Ana dal yerel; izlenecek uzak yok, FS watcher yeterli.
          }
          const out = await git(root, ['ls-remote', rb.remote, `refs/heads/${rb.branch}`]);
          const remoteSha = out.split(/\s/)[0];
          if (remoteSha && remoteSha !== refs.mainSha) {
            this.output.appendLine(`[${new Date().toISOString()}] ${refs.mainRef} güncellendi: ${remoteSha.slice(0, 7)}`);
            await this.fetchBranch(root, rb.remote, rb.branch);
            this.analyzer.invalidateRefs();
            await this.scanRoot(root, 'refs');
          }
        } catch (err) {
          if (!(err instanceof AnalyzerSkip)) {
            this.output.appendLine(`[${new Date().toISOString()}] uzak kontrol ${root}: ${String(err)}`);
          }
        }
      }
    } finally {
      this.checkingRemote = false;
    }
  }

  private fetchBranch(root: string, remote: string, branch: string): Promise<string> {
    return git(root, ['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  }

  private async fetchMain(): Promise<void> {
    const messages = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Git Conflict Radar: main getiriliyor…' },
      async () => {
        const msgs: string[] = [];
        for (const root of await this.roots()) {
          try {
            const refs = await this.analyzer.getRefs(root);
            const rb = await this.analyzer.remoteBranch(refs);
            if (!rb) {
              msgs.push(`${path.basename(root)}: ${refs.mainRef} yerel bir dal, fetch gerekmiyor`);
              continue;
            }
            await this.fetchBranch(root, rb.remote, rb.branch);
          } catch (err) {
            msgs.push(`${path.basename(root)}: ${err instanceof Error ? err.message : err}`);
          }
        }
        return msgs;
      },
    );
    if (messages.length > 0) {
      void vscode.window.showInformationMessage(messages.join('\n'));
    }
    this.refreshAll('manual');
  }

  // ---- Bildirim, durum çubuğu ve listeler ----

  private conflictId(uri: vscode.Uri, mainSha: string, c: Conflict): string {
    return `${uri.toString()}|${mainSha}|${c.theirs.map((h) => `${h.oldStart}-${h.oldEnd}`).join(',')}`;
  }

  private notifyBranch(found: Entry[], mainMoved: boolean, reason: ScanReason): void {
    const fresh: { entry: Entry; conflict: Conflict }[] = [];
    for (const entry of found) {
      for (const c of entry.result.conflicts) {
        const id = this.conflictId(entry.uri, entry.result.refs.mainSha, c);
        if (!this.notified.has(id)) {
          this.notified.add(id);
          fresh.push({ entry, conflict: c });
        }
      }
    }
    if (fresh.length === 0 || !config().showNotifications) {
      return;
    }

    const files = [...new Set(fresh.map((f) => f.entry.uri.toString()))].map(
      (k) => fresh.find((f) => f.entry.uri.toString() === k)!.entry,
    );
    const names = files.map((e) => path.basename(e.uri.fsPath));
    const shownNames = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
    const people = new Map<string, string>();
    for (const { conflict } of fresh) {
      for (const c of conflict.commits) {
        people.set(c.taskId ?? c.shortSha, c.author);
      }
    }
    const who = [...people].slice(0, 3).map(([task, author]) => `${task} (${author})`).join(', ');
    const mainRef = files[0].result.refs.mainRef;

    const head = mainMoved
      ? `${mainRef}'e yeni değişiklik geldi${who ? `: ${who}` : ''}.`
      : `Branch'iniz ${mainRef} ile çakışma riski taşıyor${who ? ` (${who})` : ''}.`;
    const message = `${head} ${files.length} dosyada çakışma riski: ${shownNames}. Lütfen tekrar düzenleyin.`;
    this.output.appendLine(`[${new Date().toISOString()}] (${reason}) ${message}`);

    const actions = files.length === 1 ? ['Dosyayı Aç', 'Farkı Göster'] : ['Çakışmaları Göster'];
    void vscode.window.showWarningMessage(message, ...actions).then((choice) => {
      if (choice === 'Dosyayı Aç') {
        void this.reveal(files[0].uri, fresh[0].conflict, files[0].lineCount);
      } else if (choice === 'Farkı Göster') {
        void this.openDiff(files[0].uri.toString());
      } else if (choice === 'Çakışmaları Göster') {
        void this.showConflicts();
      }
    });
  }

  private updateStatusBar(): void {
    const editor = vscode.window.activeTextEditor;
    if (!config().enabled) {
      this.statusBar.hide();
      return;
    }
    const all = [...this.entries.values()].filter((e) => e.result.conflicts.length > 0);
    const total = all.reduce((n, e) => n + e.result.conflicts.length, 0);
    const key = editor?.document.uri.toString();
    const entry = key ? this.entries.get(key) : undefined;
    const skip = key ? this.skipReasons.get(key) : undefined;
    const here = entry?.result.conflicts.length ?? 0;

    this.statusBar.backgroundColor = undefined;
    if (total > 0) {
      this.statusBar.text = here > 0
        ? `$(warning) ${here} çakışma` + (all.length > 1 ? ` · ${all.length} dosya` : '')
        : `$(warning) ${all.length} dosyada çakışma`;
      this.statusBar.tooltip = `${all[0].result.refs.mainRef} ile ${all.length} dosyada toplam ${total} çakışma riski. Listelemek için tıklayın.`;
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (entry) {
      this.statusBar.text = '$(check) Çakışma yok';
      this.statusBar.tooltip = `${entry.result.refs.mainRef} (${entry.result.refs.mainSha.slice(0, 7)}) ile karşılaştırıldı`;
    } else if (skip) {
      this.statusBar.text = '$(git-merge) Radar: –';
      this.statusBar.tooltip = `Git Conflict Radar: ${skip}`;
    } else if (editor?.document.uri.scheme === 'file') {
      this.statusBar.text = '$(check) Çakışma yok';
      this.statusBar.tooltip = 'Git Conflict Radar';
    } else {
      this.statusBar.hide();
      return;
    }
    this.statusBar.show();
  }

  private async showConflicts(): Promise<void> {
    const items: (vscode.QuickPickItem & { entry?: Entry; conflict?: Conflict })[] = [];
    const entries = [...this.entries.values()]
      .filter((e) => e.result.conflicts.length > 0)
      .sort((a, b) => a.result.relPath.localeCompare(b.result.relPath));
    for (const entry of entries) {
      items.push({ label: entry.result.relPath, kind: vscode.QuickPickItemKind.Separator });
      for (const c of entry.result.conflicts) {
        const { start, end } = conflictLines(c, entry.lineCount);
        const first = c.commits[0];
        items.push({
          label: `$(warning) ${conflictTasks(c)}`,
          description: `satır ${start + 1}${end > start ? `–${end + 1}` : ''}`,
          detail: first ? `${first.author}: ${first.subject}` : undefined,
          entry,
          conflict: c,
        });
      }
    }
    if (items.length === 0) {
      void vscode.window.showInformationMessage('main ile çakışma riski bulunmadı.');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Git Conflict Radar: çakışma riskleri',
      placeHolder: 'Gitmek istediğiniz çakışmayı seçin',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (pick?.entry && pick.conflict) {
      await this.reveal(pick.entry.uri, pick.conflict, pick.entry.lineCount);
    }
  }

  private async reveal(uri: vscode.Uri, conflict: Conflict, lineCount: number): Promise<void> {
    const editor = await vscode.window.showTextDocument(uri);
    const { start } = conflictLines(conflict, Math.max(lineCount, editor.document.lineCount));
    const pos = new vscode.Position(Math.min(start, editor.document.lineCount - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  // ---- Komutlar ----

  private nextConflict(): void {
    const editor = vscode.window.activeTextEditor;
    const entry = editor && this.entries.get(editor.document.uri.toString());
    if (!editor || !entry || entry.result.conflicts.length === 0) {
      void this.showConflicts();
      return;
    }
    const doc = editor.document;
    const starts = entry.result.conflicts.map((c) => conflictLines(c, doc.lineCount).start).sort((a, b) => a - b);
    const current = editor.selection.active.line;
    const target = starts.find((l) => l > current) ?? starts[0];
    const pos = new vscode.Position(target, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    void vscode.commands.executeCommand('editor.action.showHover');
  }

  private async openDiff(uriString?: string): Promise<void> {
    const uri = uriString ? vscode.Uri.parse(uriString) : vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      return;
    }
    try {
      const root = await this.analyzer.findRoot(uri.fsPath);
      if (!root) {
        throw new AnalyzerSkip('Dosya bir git reposunda değil');
      }
      const rel = this.analyzer.relativePath(root, uri.fsPath);
      const refs = await this.analyzer.getRefs(root);
      const left = vscode.Uri.from({
        scheme: MAIN_SCHEME,
        path: '/' + rel,
        query: JSON.stringify({ root, rel, sha: refs.mainSha }),
      });
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        uri,
        `${path.basename(rel)} (${refs.mainRef} ↔ çalışma kopyası)`,
      );
    } catch (err) {
      void vscode.window.showWarningMessage(`main ile karşılaştırılamadı: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async provideMainContent(uri: vscode.Uri): Promise<string> {
    const { root, rel, sha } = JSON.parse(uri.query) as { root: string; rel: string; sha: string };
    return (await tryGit(root, ['show', `${sha}:${rel}`])) ?? '';
  }
}

function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}
