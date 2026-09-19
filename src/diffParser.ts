import { diffLines } from 'diff';

/**
 * Bir değişiklik bloğu. Satır aralıkları 0 tabanlı ve yarı açıktır: [start, end).
 * start === end ise sıfır uzunluklu bir noktadır (o tarafta satır yok; örn. saf ekleme
 * durumunda eski tarafta, "start" indeksinden önceye ekleme yapılmıştır).
 */
export interface Hunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  removed: string[];
  added: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `git diff -U0` çıktısını hunk listesine çevirir (tek dosya için). */
export function parseUnifiedDiff(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;

  for (const line of text.split('\n')) {
    const m = HUNK_HEADER.exec(line);
    if (m) {
      const oldLen = m[2] === undefined ? 1 : Number(m[2]);
      const newLen = m[4] === undefined ? 1 : Number(m[4]);
      // git, uzunluk 0 olduğunda başlangıç olarak "sonrasına eklenen satırı" (1 tabanlı) verir;
      // bu da 0 tabanlı "önüne eklenen indeks" ile aynı sayıdır.
      const oldStart = oldLen === 0 ? Number(m[1]) : Number(m[1]) - 1;
      const newStart = newLen === 0 ? Number(m[3]) : Number(m[3]) - 1;
      current = {
        oldStart,
        oldEnd: oldStart + oldLen,
        newStart,
        newEnd: newStart + newLen,
        removed: [],
        added: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('-')) {
      current.removed.push(line.slice(1));
    } else if (line.startsWith('+')) {
      current.added.push(line.slice(1));
    }
  }
  return hunks;
}

/** Satır sonlarını \n'e çevirir ve metnin tam olarak bir \n ile bitmesini sağlar (git'in satır sayımıyla uyumlu). */
function normalize(text: string): string {
  const t = text.replace(/\r\n?/g, '\n');
  if (t === '' || t === '\n') {
    return '';
  }
  return t.endsWith('\n') ? t : t + '\n';
}

function toLines(value: string): string[] {
  if (value === '') {
    return [];
  }
  return value.replace(/\n$/, '').split('\n');
}

/** İki metin arasındaki farkı, git -U0 ile aynı koordinat sisteminde hunk listesi olarak döndürür. */
export function diffTexts(oldText: string, newText: string): Hunk[] {
  const hunks: Hunk[] = [];
  let o = 0;
  let n = 0;
  let current: Hunk | undefined;

  for (const change of diffLines(normalize(oldText), normalize(newText))) {
    const lines = toLines(change.value);
    if (!change.added && !change.removed) {
      o += lines.length;
      n += lines.length;
      current = undefined;
      continue;
    }
    if (!current) {
      current = { oldStart: o, oldEnd: o, newStart: n, newEnd: n, removed: [], added: [] };
      hunks.push(current);
    }
    if (change.removed) {
      current.removed.push(...lines);
      o += lines.length;
      current.oldEnd = o;
    } else {
      current.added.push(...lines);
      n += lines.length;
      current.newEnd = n;
    }
  }
  return hunks;
}
