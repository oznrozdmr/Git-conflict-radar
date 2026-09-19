import * as assert from 'assert';
import { findConflicts, rangesTouch } from '../src/conflictDetector';
import { Hunk } from '../src/diffParser';

function h(oldStart: number, oldEnd: number, added: string[] = ['x'], removed: string[] = []): Hunk {
  return { oldStart, oldEnd, newStart: oldStart, newEnd: oldStart + added.length, removed, added };
}

describe('rangesTouch', () => {
  it('kesişen, iç içe ve bitişik aralıklar', () => {
    assert.ok(rangesTouch(2, 5, 4, 8)); // kesişen
    assert.ok(rangesTouch(2, 10, 4, 5)); // iç içe
    assert.ok(rangesTouch(2, 4, 4, 6)); // bitişik
    assert.ok(!rangesTouch(2, 4, 5, 6)); // arada bir satır var
  });

  it('saf eklemeler nokta gibi davranır', () => {
    assert.ok(rangesTouch(3, 3, 3, 3));
    assert.ok(rangesTouch(3, 3, 1, 3));
    assert.ok(!rangesTouch(3, 3, 5, 5));
  });
});

describe('findConflicts', () => {
  it('örtüşen main hunklarını bizim hunk ile eşleştirir', () => {
    const ours = [h(2, 3), h(10, 12)];
    const theirs = [h(2, 3, ['y']), h(6, 7), h(11, 11)];
    const result = findConflicts(ours, theirs);
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0].theirs, [theirs[0]]);
    assert.deepStrictEqual(result[1].theirs, [theirs[2]]);
  });

  it('iki tarafta birebir aynı değişikliği çakışma saymaz', () => {
    const change = h(4, 5, ['aynı'], ['eski']);
    assert.deepStrictEqual(findConflicts([change], [{ ...change }]), []);
  });

  it('uzak değişikliklerde çakışma yok', () => {
    assert.deepStrictEqual(findConflicts([h(0, 1)], [h(5, 6)]), []);
  });
});
