import * as fs from 'fs';
import * as path from 'path';
import { findConflicts } from './conflictDetector';
import { diffTexts, Hunk, parseUnifiedDiff } from './diffParser';
import { git, tryGit } from './git';
import { CommitInfo, LOG_FORMAT, parseBlameShas, parseLogRecords, resolveTask } from './taskResolver';

export interface AnalyzerOptions {
  mainBranch: string;
  taskPattern: string;
}

export interface RefsInfo {
  root: string;
  /** Kullanılan ana dal adı (ayar bulunamazsa yedek dal olabilir). */
  mainRef: string;
  mainSha: string;
  headSha: string;
  base: string;
}

export interface Conflict {
  ours: Hunk;
  theirs: Hunk[];
  commits: CommitInfo[];
  /** true ise commit'ler satır bazında değil, dosyaya dokunan commit'lerden tahmin edildi. */
  approximate: boolean;
}

export interface AnalysisResult {
  refs: RefsInfo;
  relPath: string;
  conflicts: Conflict[];
}

/** Kullanıcıya gösterilebilecek, analiz yapılamama nedeni. */
export class AnalyzerSkip extends Error {}

const REFS_TTL_MS = 10_000;
const MAX_CACHE = 500;

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_CACHE) {
    map.clear();
  }
  map.set(key, value);
}

export class ConflictAnalyzer {
  private rootCache = new Map<string, string | null>();
  private refsCache = new Map<string, { at: number; refs: Promise<RefsInfo> }>();
  private theirsCache = new Map<string, Promise<Hunk[]>>();
  private baseTextCache = new Map<string, Promise<string>>();
  private rangeCache = new Map<string, Promise<Set<string>>>();
  private hunkCommitsCache = new Map<string, Promise<{ shas: string[]; approximate: boolean }>>();
  private commitCache = new Map<string, Promise<CommitInfo | undefined>>();

  constructor(private readonly options: () => AnalyzerOptions) {}

  /** Dal/ref değişikliğinden sonra çağrılır; içerik bazlı önbellekler SHA anahtarlı olduğundan korunur. */
  invalidateRefs(): void {
    this.refsCache.clear();
  }

  /** Ayar değiştiğinde her şeyi sıfırlar. */
  clearAll(): void {
    this.rootCache.clear();
    this.refsCache.clear();
    this.theirsCache.clear();
    this.baseTextCache.clear();
    this.rangeCache.clear();
    this.hunkCommitsCache.clear();
    this.commitCache.clear();
  }

  knownRoots(): string[] {
    return [...new Set([...this.rootCache.values()].filter((r): r is string => !!r))];
  }

  findRoot(filePath: string): Promise<string | undefined> {
    return this.findRootForDir(path.dirname(filePath));
  }

  async findRootForDir(dir: string): Promise<string | undefined> {
    if (!this.rootCache.has(dir)) {
      const out = await tryGit(dir, ['rev-parse', '--show-toplevel']);
      setBounded(this.rootCache, dir, out ? out.trim() : null);
    }
    return this.rootCache.get(dir) ?? undefined;
  }

  getRefs(root: string): Promise<RefsInfo> {
    const cached = this.refsCache.get(root);
    if (cached && Date.now() - cached.at < REFS_TTL_MS) {
      return cached.refs;
    }
    const refs = this.computeRefs(root);
    this.refsCache.set(root, { at: Date.now(), refs });
    refs.catch(() => this.refsCache.delete(root));
    return refs;
  }

  private async computeRefs(root: string): Promise<RefsInfo> {
    const configured = this.options().mainBranch.trim() || 'origin/main';
    const candidates = [...new Set([configured, 'main', 'master', 'origin/main', 'origin/master'])];

    let mainRef: string | undefined;
    let mainSha: string | undefined;
    for (const ref of candidates) {
      const out = await tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      if (out) {
        mainRef = ref;
        mainSha = out.trim();
        break;
      }
    }
    if (!mainRef || !mainSha) {
      throw new AnalyzerSkip(`Ana dal bulunamadı (${candidates.join(', ')})`);
    }

    const head = await tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (!head) {
      throw new AnalyzerSkip('Bu repoda henüz commit yok');
    }
    const headSha = head.trim();

    const base = await tryGit(root, ['merge-base', headSha, mainSha]);
    if (!base) {
      throw new AnalyzerSkip(`HEAD ile ${mainRef} arasında ortak ata yok`);
    }
    return { root, mainRef, mainSha, headSha, base: base.trim() };
  }

  /**
   * Dosyanın editördeki güncel içeriğini (kaydedilmemiş hali dahil) main ile karşılaştırır.
   */
  async analyze(filePath: string, text: string): Promise<AnalysisResult> {
    const root = await this.findRoot(filePath);
    if (!root) {
      throw new AnalyzerSkip('Dosya bir git reposunda değil');
    }
    const relPath = this.relativePath(root, filePath);
    const refs = await this.getRefs(root);

    const [theirs, baseText] = await Promise.all([this.theirsHunks(refs, relPath), this.baseText(refs, relPath)]);
    if (theirs.length === 0) {
      return { refs, relPath, conflicts: [] };
    }

    const ours = diffTexts(baseText, text);
    const matches = findConflicts(ours, theirs);

    const conflicts = await Promise.all(
      matches.map(async (m) => {
        const perHunk = await Promise.all(m.theirs.map((h) => this.commitsForHunk(refs, relPath, h)));
        const shas = [...new Set(perHunk.flatMap((p) => p.shas))];
        const commits = (await Promise.all(shas.map((s) => this.commitInfo(refs, s)))).filter(
          (c): c is CommitInfo => !!c,
        );
        commits.sort((a, b) => b.time - a.time);
        return { ours: m.ours, theirs: m.theirs, commits, approximate: perHunk.some((p) => p.approximate) };
      }),
    );
    return { refs, relPath, conflicts };
  }

  /**
   * Hem sizin tarafınızda (commit'li ya da diskte commit'siz) hem de main'de değişmiş dosyalar.
   * Yalnızca bu dosyalarda çakışma olabileceği için branch taraması bunlarla sınırlıdır.
   */
  async candidateFiles(refs: RefsInfo): Promise<string[]> {
    if (refs.base === refs.mainSha) {
      return [];
    }
    const names = (out: string) => out.split('\n').filter(Boolean);
    const theirs = names(await git(refs.root, ['diff', '--name-only', '--no-renames', refs.base, refs.mainSha]));
    if (theirs.length === 0) {
      return [];
    }
    const [ours, untracked] = await Promise.all([
      git(refs.root, ['diff', '--name-only', '--no-renames', refs.base]).then(names),
      git(refs.root, ['ls-files', '--others', '--exclude-standard']).then(names),
    ]);
    const mine = new Set([...ours, ...untracked]);
    return theirs.filter((f) => mine.has(f));
  }

  /** Ana dal bir uzak dal ise (örn. origin/main) uzak adını ve dal adını döndürür. */
  async remoteBranch(refs: RefsInfo): Promise<{ remote: string; branch: string } | undefined> {
    const remotes = (await git(refs.root, ['remote'])).split('\n').filter(Boolean);
    const remote = remotes.find((r) => refs.mainRef.startsWith(`${r}/`));
    return remote ? { remote, branch: refs.mainRef.slice(remote.length + 1) } : undefined;
  }

  /** main'deki dosya içeriği (dosya main'de yoksa boş metin). */
  async mainText(root: string, relPath: string): Promise<{ ref: string; text: string }> {
    const refs = await this.getRefs(root);
    const text = (await tryGit(root, ['show', `${refs.mainSha}:${relPath}`])) ?? '';
    return { ref: refs.mainRef, text };
  }

  relativePath(root: string, filePath: string): string {
    let real = filePath;
    try {
      real = fs.realpathSync.native(filePath);
    } catch {
      // Dosya henüz diske kaydedilmemiş olabilir; olduğu gibi kullan.
    }
    let realRoot = root;
    try {
      realRoot = fs.realpathSync.native(root);
    } catch {
      // yoksay
    }
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new AnalyzerSkip('Dosya repo dışında');
    }
    return rel.split(path.sep).join('/');
  }

  private theirsHunks(refs: RefsInfo, relPath: string): Promise<Hunk[]> {
    const key = `${refs.root}\0${relPath}\0${refs.base}\0${refs.mainSha}`;
    let p = this.theirsCache.get(key);
    if (!p) {
      p = refs.base === refs.mainSha
        ? Promise.resolve([])
        : git(refs.root, [
            'diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
            refs.base, refs.mainSha, '--', relPath,
          ]).then(parseUnifiedDiff);
      setBounded(this.theirsCache, key, p);
      p.catch(() => this.theirsCache.delete(key));
    }
    return p;
  }

  private baseText(refs: RefsInfo, relPath: string): Promise<string> {
    const key = `${refs.root}\0${relPath}\0${refs.base}`;
    let p = this.baseTextCache.get(key);
    if (!p) {
      p = tryGit(refs.root, ['show', `${refs.base}:${relPath}`]).then((t) => t ?? '');
      setBounded(this.baseTextCache, key, p);
    }
    return p;
  }

  /** base..main aralığındaki commit'ler. */
  private rangeShas(refs: RefsInfo): Promise<Set<string>> {
    const key = `${refs.root}\0${refs.base}\0${refs.mainSha}`;
    let p = this.rangeCache.get(key);
    if (!p) {
      p = git(refs.root, ['rev-list', `${refs.base}..${refs.mainSha}`]).then(
        (out) => new Set(out.split('\n').filter(Boolean)),
      );
      setBounded(this.rangeCache, key, p);
      p.catch(() => this.rangeCache.delete(key));
    }
    return p;
  }

  private commitsForHunk(refs: RefsInfo, relPath: string, h: Hunk): Promise<{ shas: string[]; approximate: boolean }> {
    const key = `${refs.root}\0${relPath}\0${refs.base}\0${refs.mainSha}\0${h.oldStart}:${h.oldEnd}:${h.newStart}:${h.newEnd}`;
    let p = this.hunkCommitsCache.get(key);
    if (!p) {
      p = this.computeCommitsForHunk(refs, relPath, h);
      setBounded(this.hunkCommitsCache, key, p);
      p.catch(() => this.hunkCommitsCache.delete(key));
    }
    return p;
  }

  private async computeCommitsForHunk(
    refs: RefsInfo,
    relPath: string,
    h: Hunk,
  ): Promise<{ shas: string[]; approximate: boolean }> {
    const inRange = await this.rangeShas(refs);

    // main'de satır eklenmiş/değiştirilmişse: o satırları blame ile doğrudan bul.
    if (h.newEnd > h.newStart) {
      const out = await tryGit(refs.root, [
        'blame', '--porcelain', '-L', `${h.newStart + 1},${h.newEnd}`, refs.mainSha, '--', relPath,
      ]);
      const shas = out ? parseBlameShas(out).filter((s) => inRange.has(s)) : [];
      if (shas.length > 0) {
        return { shas, approximate: false };
      }
    }

    // Sadece silme yapılmışsa satır kalmadığı için blame edilemez: dosyaya dokunan son commit'lere bak.
    const out = await tryGit(refs.root, [
      'log', '--format=%H', '-n', '5', `${refs.base}..${refs.mainSha}`, '--', relPath,
    ]);
    const shas = (out ?? '').split('\n').filter(Boolean);
    return { shas, approximate: true };
  }

  private commitInfo(refs: RefsInfo, sha: string): Promise<CommitInfo | undefined> {
    const pattern = this.options().taskPattern;
    const key = `${refs.root}\0${sha}\0${refs.mainSha}\0${pattern}`;
    let p = this.commitCache.get(key);
    if (!p) {
      p = this.computeCommitInfo(refs, sha, pattern);
      setBounded(this.commitCache, key, p);
      p.catch(() => this.commitCache.delete(key));
    }
    return p;
  }

  private async computeCommitInfo(refs: RefsInfo, sha: string, pattern: string): Promise<CommitInfo | undefined> {
    const out = await tryGit(refs.root, ['log', '--no-walk', `--format=${LOG_FORMAT}`, sha]);
    const [commit] = parseLogRecords(out ?? '');
    if (!commit) {
      return undefined;
    }

    let task = resolveTask(commit, undefined, pattern);
    if (!task.taskId) {
      // Commit'i main'e getiren ilk merge commit'i bul ve branch adından task çıkarmayı dene.
      const merges = await tryGit(refs.root, [
        'log', '--ancestry-path', '--merges', '--reverse', `--format=${LOG_FORMAT}`, `${sha}..${refs.mainSha}`,
      ]);
      const [merge] = parseLogRecords(merges ?? '');
      task = resolveTask(commit, merge, pattern);
    }
    return { ...commit, ...task };
  }
}
