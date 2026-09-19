export const DEFAULT_TASK_PATTERN = '[A-Z][A-Z0-9]+-\\d+|#\\d+';

export type TaskSource = 'commit' | 'branch' | 'merge';

export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  /** Unix zamanı (saniye). */
  time: number;
  subject: string;
  body: string;
  taskId?: string;
  /** Task ID'nin nereden bulunduğu: commit mesajı, merge edilen branch adı ya da merge mesajı. */
  taskSource?: TaskSource;
  mergeBranch?: string;
}

function compile(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(DEFAULT_TASK_PATTERN);
  }
}

/** Metindeki ilk task ID'sini döndürür (örn. "PROJ-123" ya da "#45"). */
export function extractTaskId(text: string, pattern: string = DEFAULT_TASK_PATTERN): string | undefined {
  const m = compile(pattern).exec(text);
  return m ? m[0] : undefined;
}

const MERGE_PATTERNS: RegExp[] = [
  /^Merge pull request #\d+ from [^/\s]+\/(\S+)/, // GitHub
  /^Merge (?:remote-tracking )?branch '([^']+)'/, // git, GitLab
  /^Merge (?:remote-tracking )?branch "([^"]+)"/,
  /^Merged in (\S+)/, // Bitbucket
];

/** Merge commit başlığından merge edilen branch adını çıkarır. */
export function parseMergeBranch(subject: string): string | undefined {
  for (const re of MERGE_PATTERNS) {
    const m = re.exec(subject.trim());
    if (m) {
      return m[1];
    }
  }
  return undefined;
}

/** `git blame --porcelain` çıktısındaki benzersiz commit SHA'larını sırasıyla döndürür. */
export function parseBlameShas(porcelain: string): string[] {
  const seen = new Set<string>();
  for (const line of porcelain.split('\n')) {
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ \d+/.exec(line);
    if (m) {
      seen.add(m[1]);
    }
  }
  return [...seen];
}

/** Commit bilgisini okumak için kullanılan `git log --format` değeri. */
export const LOG_FORMAT = '%H%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e';

export function parseLogRecords(out: string): CommitInfo[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.trim() !== '')
    .map((r) => {
      const [sha, author, email, time, subject, body = ''] = r.split('\x1f');
      return {
        sha,
        shortSha: sha.slice(0, 7),
        author,
        email,
        time: Number(time),
        subject,
        body: body.trim(),
      };
    });
}

/**
 * Commit'in task ID'sini belirler. Önce commit mesajına, sonra (commit bir merge ise)
 * kendi branch adına, en son da onu main'e getiren merge commit'e bakar.
 */
export function resolveTask(
  commit: CommitInfo,
  mergeCommit: { subject: string; body: string } | undefined,
  pattern: string,
): Pick<CommitInfo, 'taskId' | 'taskSource' | 'mergeBranch'> {
  const fromMessage = extractTaskId(`${commit.subject}\n${commit.body}`, pattern);
  const ownBranch = parseMergeBranch(commit.subject);
  if (ownBranch) {
    const fromBranch = extractTaskId(ownBranch, pattern);
    if (fromBranch) {
      return { taskId: fromBranch, taskSource: 'branch', mergeBranch: ownBranch };
    }
  }
  if (fromMessage) {
    return { taskId: fromMessage, taskSource: 'commit' };
  }
  if (mergeCommit) {
    const branch = parseMergeBranch(mergeCommit.subject);
    const fromBranch = branch ? extractTaskId(branch, pattern) : undefined;
    if (fromBranch) {
      return { taskId: fromBranch, taskSource: 'branch', mergeBranch: branch };
    }
    const fromMerge = extractTaskId(`${mergeCommit.subject}\n${mergeCommit.body}`, pattern);
    if (fromMerge) {
      return { taskId: fromMerge, taskSource: 'merge', mergeBranch: branch };
    }
    return { mergeBranch: branch };
  }
  return {};
}
