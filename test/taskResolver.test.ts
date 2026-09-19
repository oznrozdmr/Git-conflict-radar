import * as assert from 'assert';
import {
  CommitInfo,
  extractTaskId,
  parseBlameShas,
  parseLogRecords,
  parseMergeBranch,
  resolveTask,
} from '../src/taskResolver';

function commit(subject: string, body = ''): CommitInfo {
  return { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', author: 'x', email: 'x@y', time: 0, subject, body };
}

describe('extractTaskId', () => {
  it('Jira ve GitHub biçimleri', () => {
    assert.strictEqual(extractTaskId('PROJ-123: login'), 'PROJ-123');
    assert.strictEqual(extractTaskId('fix: bug (#45)'), '#45');
    assert.strictEqual(extractTaskId('feature/AB2-9-xyz'), 'AB2-9');
    assert.strictEqual(extractTaskId('task yok'), undefined);
  });

  it('özel ve geçersiz regex', () => {
    assert.strictEqual(extractTaskId('iş: T123 bitti', 'T\\d+'), 'T123');
    assert.strictEqual(extractTaskId('PROJ-1', '(['), 'PROJ-1'); // geçersiz -> varsayılan
  });
});

describe('parseMergeBranch', () => {
  it('yaygın merge mesajları', () => {
    assert.strictEqual(parseMergeBranch("Merge branch 'feature/PROJ-12-x'"), 'feature/PROJ-12-x');
    assert.strictEqual(parseMergeBranch("Merge branch 'feature/PROJ-12' into 'main'"), 'feature/PROJ-12');
    assert.strictEqual(parseMergeBranch('Merge pull request #5 from ayse/feature/PROJ-7'), 'feature/PROJ-7');
    assert.strictEqual(parseMergeBranch("Merge remote-tracking branch 'origin/bugfix/X-1'"), 'origin/bugfix/X-1');
    assert.strictEqual(parseMergeBranch('Merged in feature/ABC-3 (pull request #9)'), 'feature/ABC-3');
    assert.strictEqual(parseMergeBranch('normal commit'), undefined);
  });
});

describe('resolveTask', () => {
  it('önce commit mesajı', () => {
    assert.deepStrictEqual(resolveTask(commit('PROJ-1: x'), undefined, '[A-Z]+-\\d+'), {
      taskId: 'PROJ-1',
      taskSource: 'commit',
    });
  });

  it('mesajda yoksa merge edilen branch adı', () => {
    const r = resolveTask(commit('footer'), { subject: "Merge branch 'feature/PROJ-150-footer'", body: '' }, '[A-Z]+-\\d+');
    assert.deepStrictEqual(r, { taskId: 'PROJ-150', taskSource: 'branch', mergeBranch: 'feature/PROJ-150-footer' });
  });

  it('branch adında da yoksa merge mesajı (PR numarası)', () => {
    const r = resolveTask(
      commit('footer'),
      { subject: 'Merge pull request #77 from ayse/footer', body: 'Footer' },
      '[A-Z]+-\\d+|#\\d+',
    );
    assert.strictEqual(r.taskId, '#77');
    assert.strictEqual(r.taskSource, 'merge');
  });

  it("merge commit'in kendisi için branch adı PR numarasından önce gelir", () => {
    const r = resolveTask(commit('Merge pull request #5 from ayse/feature/PROJ-7'), undefined, '[A-Z]+-\\d+|#\\d+');
    assert.strictEqual(r.taskId, 'PROJ-7');
  });
});

describe('parsers', () => {
  it('blame porcelain', () => {
    const a = '1'.repeat(40);
    const b = '2'.repeat(40);
    const out = [`${a} 1 1 2`, 'author X', 'summary 123 45', '\tkod', `${a} 2 2`, '\tkod', `${b} 3 3 1`, '\tkod'].join('\n');
    assert.deepStrictEqual(parseBlameShas(out), [a, b]);
  });

  it('log kayıtları', () => {
    const out = `${'f'.repeat(40)}\x1fAyşe\x1fa@b\x1f1700000000\x1fPROJ-1: x\x1fgövde\n\x1e\n`;
    const [c] = parseLogRecords(out);
    assert.strictEqual(c.shortSha, 'fffffff');
    assert.strictEqual(c.author, 'Ayşe');
    assert.strictEqual(c.time, 1700000000);
    assert.strictEqual(c.body, 'gövde');
  });
});
