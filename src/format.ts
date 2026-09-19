import { Conflict } from './analyzer';
import { CommitInfo } from './taskResolver';

/** Çakışmanın editördeki satır aralığı (0 tabanlı, iki uç dahil). */
export function conflictLines(c: Conflict, lineCount: number): { start: number; end: number } {
  const last = Math.max(0, lineCount - 1);
  if (c.ours.newEnd > c.ours.newStart) {
    return { start: Math.min(c.ours.newStart, last), end: Math.min(c.ours.newEnd - 1, last) };
  }
  // Siz satır sildiyseniz silinen yerin hemen altındaki (yoksa üstündeki) satırı işaretle.
  const line = Math.min(c.ours.newStart, last);
  return { start: line, end: line };
}

export function taskLabel(c: CommitInfo): string {
  return c.taskId ?? `commit ${c.shortSha}`;
}

/** Çakışmaya neden olan task'ların kısa listesi, örn. "PROJ-12, PROJ-15". */
export function conflictTasks(c: Conflict): string {
  if (c.commits.length === 0) {
    return 'bilinmeyen commit';
  }
  return [...new Set(c.commits.map(taskLabel))].join(', ');
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
}

export function taskUrl(taskId: string, template: string): string | undefined {
  if (!template.includes('{id}')) {
    return undefined;
  }
  return template.split('{id}').join(encodeURIComponent(taskId.replace(/^#/, '')));
}

export function taskSourceText(c: CommitInfo): string | undefined {
  switch (c.taskSource) {
    case 'branch':
      return `task, merge edilen branch adından bulundu: ${c.mergeBranch}`;
    case 'merge':
      return 'task, merge commit mesajından bulundu';
    default:
      return undefined;
  }
}

/** main'deki değişikliği diff biçiminde verir (uzunsa kısaltır). */
export function theirsDiff(c: Conflict, maxLines = 20): string {
  const lines: string[] = [];
  for (const h of c.theirs) {
    lines.push(...h.removed.map((l) => `- ${l}`), ...h.added.map((l) => `+ ${l}`));
  }
  if (lines.length > maxLines) {
    const hidden = lines.length - maxLines;
    return [...lines.slice(0, maxLines), `… (${hidden} satır daha)`].join('\n');
  }
  return lines.join('\n');
}
