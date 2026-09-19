import * as path from 'path';
import * as vscode from 'vscode';
import { AnalysisResult, AnalyzerSkip, ConflictAnalyzer } from './analyzer';
import { ConflictDecorations } from './decorations';
import { ConflictDiagnostics } from './diagnostics';
import { conflictLines, conflictTasks } from './format';
import { git } from './git';
import { ConflictHoverProvider } from './hoverProvider';
import { DEFAULT_TASK_PATTERN } from './taskResolver';

const CONFIG = 'gitConflictRadar';
const MAIN_SCHEME = 'gcr-main';
const TYPING_DELAY_MS = 500;
const MAX_LINES = 50_000;

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
    autoFetchMinutes: c.get<number>('autoFetchMinutes', 0),
    showNotifications: c.get<boolean>('showNotifications', true),
  };
}

class RadarController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly analyzer = new ConflictAnalyzer(() => config());
  private readonly decorations: ConflictDecorations;
  private readonly diagnostics = new ConflictDiagnostics();
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly output = vscode.window.createOutputChannel('Git Conflict Radar');

  private readonly results = new Map<string, AnalysisResult>();
  private readonly skipReasons = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly runIds = new Map<string, number>();
  private readonly notified = new Map<string, Set<string>>();
  private refsTimer: NodeJS.Timeout | undefined;
  private fetchTimer: NodeJS.Timeout | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.decorations = new ConflictDecorations(context);
    this.statusBar.command = 'gitConflictRadar.nextConflict';

    this.disposables.push(
      this.decorations,
      this.diagnostics,
      this.statusBar,
      this.output,
      vscode.languages.registerHoverProvider(
        { scheme: 'file' },
        new ConflictHoverProvider((uri) => this.results.get(uri.toString()), () => config().taskUrlTemplate),
      ),
      vscode.workspace.registerTextDocumentContentProvider(MAIN_SCHEME, {
        provideTextDocumentContent: (uri) => this.provideMainContent(uri),
      }),
      vscode.commands.registerCommand('gitConflictRadar.refresh', () => this.refreshAll(true)),
      vscode.commands.registerCommand('gitConflictRadar.fetchMain', () => this.fetchMain(true)),
      vscode.commands.registerCommand('gitConflictRadar.openDiffWithMain', (uri?: string) => this.openDiff(uri)),
      vscode.commands.registerCommand('gitConflictRadar.nextConflict', () => this.nextConflict()),
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
      vscode.workspace.onDidSaveTextDocument((doc) => this.schedule(doc, 0)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.forget(doc.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG)) {
          this.analyzer.clearAll();
          this.setupAutoFetch();
          this.refreshAll(false);
        }
      }),
    );

    // Dal değişimi, commit, fetch, pull gibi ref değişikliklerini izle.
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/.git/{HEAD,FETCH_HEAD,ORIG_HEAD,packed-refs,refs/**}',
    );
    const onRefs = () => this.onRefsChanged();
    this.disposables.push(watcher, watcher.onDidChange(onRefs), watcher.onDidCreate(onRefs), watcher.onDidDelete(onRefs));
    this.watchBuiltInGit();

    this.setupAutoFetch();
    vscode.window.visibleTextEditors.forEach((e) => this.showOrSchedule(e));
    this.updateStatusBar();
  }

  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    if (this.refsTimer) {
      clearTimeout(this.refsTimer);
    }
    if (this.fetchTimer) {
      clearInterval(this.fetchTimer);
    }
    this.disposables.forEach((d) => d.dispose());
  }

  // ---- Analiz ----

  private isVisible(doc: vscode.TextDocument): boolean {
    return vscode.window.visibleTextEditors.some((e) => e.document === doc);
  }

  private showOrSchedule(editor: vscode.TextEditor): void {
    const result = this.results.get(editor.document.uri.toString());
    if (result) {
      this.decorations.apply(editor, result.conflicts, result.refs.mainRef);
    } else {
      this.schedule(editor.document, 0);
    }
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
        void this.run(doc);
      }, delay),
    );
  }

  private async run(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    const runId = (this.runIds.get(key) ?? 0) + 1;
    this.runIds.set(key, runId);

    if (!config().enabled || doc.isClosed) {
      this.clearDocument(doc.uri);
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
      this.skipReasons.delete(key);
      this.results.set(key, result);
      this.render(doc, result);
      this.maybeNotify(doc, result);
    } catch (err) {
      if (this.runIds.get(key) !== runId) {
        return;
      }
      if (!(err instanceof AnalyzerSkip)) {
        this.output.appendLine(`[${new Date().toISOString()}] ${doc.uri.fsPath}: ${String(err)}`);
      }
      this.setSkip(doc.uri, err instanceof AnalyzerSkip ? err.message : 'Analiz hatası (Output > Git Conflict Radar)');
    }
  }

  private render(doc: vscode.TextDocument, result: AnalysisResult): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === doc) {
        this.decorations.apply(editor, result.conflicts, result.refs.mainRef);
      }
    }
    this.diagnostics.set(doc, result);
    this.updateStatusBar();
  }

  private setSkip(uri: vscode.Uri, reason: string): void {
    this.clearDocument(uri);
    this.skipReasons.set(uri.toString(), reason);
    this.updateStatusBar();
  }

  private clearDocument(uri: vscode.Uri): void {
    this.results.delete(uri.toString());
    this.skipReasons.delete(uri.toString());
    this.diagnostics.delete(uri);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri.toString()) {
        this.decorations.clear(editor);
      }
    }
    this.updateStatusBar();
  }

  private forget(uri: vscode.Uri): void {
    const key = uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.runIds.delete(key);
    this.notified.delete(key);
    this.clearDocument(uri);
  }

  private refreshAll(invalidateRefs: boolean): void {
    if (invalidateRefs) {
      this.analyzer.invalidateRefs();
    }
    if (!config().enabled) {
      this.diagnostics.clear();
      vscode.window.visibleTextEditors.forEach((e) => this.decorations.clear(e));
      this.results.clear();
      this.skipReasons.clear();
      this.updateStatusBar();
      return;
    }
    const docs = new Set(vscode.window.visibleTextEditors.map((e) => e.document));
    docs.forEach((d) => this.schedule(d, 0));
  }

  private onRefsChanged(): void {
    if (this.refsTimer) {
      clearTimeout(this.refsTimer);
    }
    this.refsTimer = setTimeout(() => this.refreshAll(true), 1000);
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
              this.onRefsChanged();
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

  // ---- Bildirim ve durum çubuğu ----

  private maybeNotify(doc: vscode.TextDocument, result: AnalysisResult): void {
    if (!config().showNotifications || result.conflicts.length === 0) {
      return;
    }
    const key = doc.uri.toString();
    const seen = this.notified.get(key) ?? new Set<string>();
    this.notified.set(key, seen);

    const fresh = result.conflicts.filter((c) => {
      const id = `${result.refs.mainSha}:${c.theirs.map((h) => `${h.oldStart}-${h.oldEnd}`).join(',')}`;
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
    if (fresh.length === 0) {
      return;
    }

    const tasks = [...new Set(fresh.map(conflictTasks))].join(', ');
    const name = path.basename(doc.uri.fsPath);
    void vscode.window
      .showWarningMessage(
        `${name}: ${fresh.length} bölge ${result.refs.mainRef}'de de değiştirildi (${tasks}). Lütfen tekrar düzenleyin.`,
        'Farkı Göster',
        'Çakışmaya Git',
      )
      .then((choice) => {
        if (choice === 'Farkı Göster') {
          void this.openDiff(key);
        } else if (choice === 'Çakışmaya Git') {
          void vscode.window.showTextDocument(doc).then(() => this.nextConflict());
        }
      });
  }

  private updateStatusBar(): void {
    const editor = vscode.window.activeTextEditor;
    if (!config().enabled || !editor || editor.document.uri.scheme !== 'file') {
      this.statusBar.hide();
      return;
    }
    const key = editor.document.uri.toString();
    const result = this.results.get(key);
    const skip = this.skipReasons.get(key);

    this.statusBar.backgroundColor = undefined;
    if (result && result.conflicts.length > 0) {
      const n = result.conflicts.length;
      this.statusBar.text = `$(warning) ${n} çakışma`;
      this.statusBar.tooltip = `${result.refs.mainRef} ile ${n} çakışma riski. Sonrakine gitmek için tıklayın.`;
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (result) {
      this.statusBar.text = '$(check) Çakışma yok';
      this.statusBar.tooltip = `${result.refs.mainRef} (${result.refs.mainSha.slice(0, 7)}) ile karşılaştırıldı`;
    } else if (skip) {
      this.statusBar.text = '$(git-merge) Radar: –';
      this.statusBar.tooltip = `Git Conflict Radar: ${skip}`;
    } else {
      this.statusBar.text = '$(sync~spin) Radar';
      this.statusBar.tooltip = 'Git Conflict Radar taranıyor…';
    }
    this.statusBar.show();
  }

  // ---- Komutlar ----

  private nextConflict(): void {
    const editor = vscode.window.activeTextEditor;
    const result = editor && this.results.get(editor.document.uri.toString());
    if (!editor || !result || result.conflicts.length === 0) {
      void vscode.window.showInformationMessage('Bu dosyada çakışma riski yok.');
      return;
    }
    const doc = editor.document;
    const starts = result.conflicts.map((c) => conflictLines(c, doc.lineCount).start).sort((a, b) => a - b);
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
    const { root, rel } = JSON.parse(uri.query) as { root: string; rel: string };
    return (await this.analyzer.mainText(root, rel)).text;
  }

  private async fetchMain(interactive: boolean): Promise<void> {
    const roots = new Set<string>(this.analyzer.knownRoots());
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme === 'file') {
        const root = await this.analyzer.findRoot(editor.document.uri.fsPath);
        if (root) {
          roots.add(root);
        }
      }
    }

    const work = async () => {
      const messages: string[] = [];
      for (const root of roots) {
        try {
          const refs = await this.analyzer.getRefs(root);
          const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean);
          const remote = remotes.find((r) => refs.mainRef.startsWith(`${r}/`));
          if (!remote) {
            messages.push(`${path.basename(root)}: ${refs.mainRef} yerel bir dal, fetch gerekmiyor`);
            continue;
          }
          await git(root, ['fetch', '--quiet', remote, refs.mainRef.slice(remote.length + 1)]);
        } catch (err) {
          messages.push(`${path.basename(root)}: ${err instanceof Error ? err.message : err}`);
          this.output.appendLine(`fetch ${root}: ${String(err)}`);
        }
      }
      return messages;
    };

    const messages = interactive
      ? await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Git Conflict Radar: main getiriliyor…' },
          work,
        )
      : await work();
    if (interactive && messages.length > 0) {
      void vscode.window.showInformationMessage(messages.join('\n'));
    }
    this.refreshAll(true);
  }

  private setupAutoFetch(): void {
    if (this.fetchTimer) {
      clearInterval(this.fetchTimer);
      this.fetchTimer = undefined;
    }
    const minutes = config().autoFetchMinutes;
    if (config().enabled && minutes > 0) {
      this.fetchTimer = setInterval(() => void this.fetchMain(false), minutes * 60_000);
    }
  }
}
