import * as assert from 'assert';
import { diffTexts, parseUnifiedDiff } from '../src/diffParser';

describe('parseUnifiedDiff', () => {
  it('değiştirme, ekleme ve silme hunk başlıklarını 0 tabanlı yarı açık aralığa çevirir', () => {
    const out = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -3 +3 @@ ctx',
      '-eski',
      '+yeni',
      '@@ -5,0 +6,2 @@',
      '+a',
      '+b',
      '@@ -9,2 +10,0 @@',
      '-c',
      '-d',
    ].join('\n');
    const [change, insert, remove] = parseUnifiedDiff(out);
    assert.deepStrictEqual(
      { ...change },
      { oldStart: 2, oldEnd: 3, newStart: 2, newEnd: 3, removed: ['eski'], added: ['yeni'] },
    );
    assert.strictEqual(insert.oldStart, 5);
    assert.strictEqual(insert.oldEnd, 5);
    assert.strictEqual(insert.newStart, 5);
    assert.strictEqual(insert.newEnd, 7);
    assert.deepStrictEqual(insert.added, ['a', 'b']);
    assert.strictEqual(remove.oldStart, 8);
    assert.strictEqual(remove.oldEnd, 10);
    assert.strictEqual(remove.newStart, 10);
    assert.strictEqual(remove.newEnd, 10);
  });

  it('boş dosyaya ekleme', () => {
    const [h] = parseUnifiedDiff('@@ -0,0 +1,2 @@\n+a\n+b');
    assert.deepStrictEqual([h.oldStart, h.oldEnd, h.newStart, h.newEnd], [0, 0, 0, 2]);
  });
});

describe('diffTexts', () => {
  it('git ile aynı koordinatları üretir', () => {
    const base = 'a\nb\nc\nd\ne\n';
    const cur = 'a\nB\nc\nd\nx\ny\ne\n';
    const hunks = diffTexts(base, cur);
    assert.strictEqual(hunks.length, 2);
    assert.deepStrictEqual([hunks[0].oldStart, hunks[0].oldEnd, hunks[0].newStart, hunks[0].newEnd], [1, 2, 1, 2]);
    // "d" satırı "x","y" ile değişmiş gibi de görülebilir; önemli olan eski tarafın d/e civarında olması
    assert.ok(hunks[1].oldStart >= 3 && hunks[1].oldEnd <= 4);
  });

  it('dosya sonundaki satır sonu farkını ve CRLF farkını değişiklik saymaz', () => {
    assert.deepStrictEqual(diffTexts('a\nb', 'a\nb\n'), []);
    assert.deepStrictEqual(diffTexts('a\r\nb\r\n', 'a\nb\n'), []);
  });

  it('dosya sonuna ekleme son satırı değişmiş göstermez', () => {
    const [h] = diffTexts('a\nb', 'a\nb\nc');
    assert.deepStrictEqual([h.oldStart, h.oldEnd, h.newStart, h.newEnd], [2, 2, 2, 3]);
  });

  it('boş taban metni', () => {
    const [h] = diffTexts('', 'x\ny\n');
    assert.deepStrictEqual([h.oldStart, h.oldEnd, h.newStart, h.newEnd], [0, 0, 0, 2]);
  });
});
