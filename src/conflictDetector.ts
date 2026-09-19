import { Hunk } from './diffParser';

export interface ConflictMatch {
  /** Sizin taraftaki (çalışma kopyası) değişiklik. */
  ours: Hunk;
  /** Aynı bölgede main'de yapılmış değişiklikler. */
  theirs: Hunk[];
}

/**
 * İki aralık kesişiyor ya da bitişikse true döner. git de bitişik değişiklikleri
 * çakışma sayar; sıfır uzunluklu aralıklar (saf eklemeler) nokta gibi davranır.
 */
export function rangesTouch(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function sameChange(a: Hunk, b: Hunk): boolean {
  return (
    a.oldStart === b.oldStart &&
    a.oldEnd === b.oldEnd &&
    a.removed.length === b.removed.length &&
    a.added.length === b.added.length &&
    a.removed.every((l, i) => l === b.removed[i]) &&
    a.added.every((l, i) => l === b.added[i])
  );
}

/**
 * Ortak ata (merge-base) koordinatlarında örtüşen değişiklikleri bulur.
 * Her iki tarafta birebir aynı yapılmış değişiklikler git tarafından temiz birleştirildiği için atlanır.
 */
export function findConflicts(ours: Hunk[], theirs: Hunk[]): ConflictMatch[] {
  const result: ConflictMatch[] = [];
  for (const o of ours) {
    const overlapping = theirs.filter(
      (t) => rangesTouch(o.oldStart, o.oldEnd, t.oldStart, t.oldEnd) && !sameChange(o, t),
    );
    if (overlapping.length > 0) {
      result.push({ ours: o, theirs: overlapping });
    }
  }
  return result;
}
