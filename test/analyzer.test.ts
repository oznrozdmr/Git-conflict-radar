import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConflictAnalyzer } from '../src/analyzer';

describe('ConflictAnalyzer (gerçek git reposu)', function () {
  this.timeout(20_000);
  let repo: string;
  let analyzer: ConflictAnalyzer;

  before(() => {
    repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gcr-')), 'repo');
    execFileSync(path.join(__dirname, '..', '..', 'scripts', 'make-test-repo.sh'), [repo]);
    analyzer = new ConflictAnalyzer(() => ({ mainBranch: 'origin/main', taskPattern: '[A-Z][A-Z0-9]+-\\d+|#\\d+' }));
  });

  after(() => fs.rmSync(path.dirname(repo), { recursive: true, force: true }));

  it('commitli ve kaydedilmemiş çakışmaları task bilgisiyle bulur', async () => {
    const file = path.join(repo, 'app.js');
    const result = await analyzer.analyze(file, fs.readFileSync(file, 'utf8'));

    assert.strictEqual(result.refs.mainRef, 'main'); // origin/main yok -> yedek dal
    assert.strictEqual(result.relPath, 'app.js');
    assert.strictEqual(result.conflicts.length, 2);

    const [login, footer] = result.conflicts;
    assert.strictEqual(login.ours.newStart, 2);
    assert.deepStrictEqual(login.ours.added, ['  return checkProfile(user);']);
    assert.strictEqual(login.commits.length, 1);
    assert.strictEqual(login.commits[0].taskId, 'PROJ-101');
    assert.strictEqual(login.commits[0].taskSource, 'commit');
    assert.deepStrictEqual(login.theirs[0].added, ['  return user && password.length >= 8;']);

    assert.strictEqual(footer.ours.newStart, 8);
    assert.strictEqual(footer.commits[0].taskId, 'PROJ-150');
    assert.strictEqual(footer.commits[0].taskSource, 'branch');
    assert.strictEqual(footer.commits[0].author, 'Mehmet Kaya');
  });

  it('main ile çakışmayan düzenleme işaretlenmez', async () => {
    const file = path.join(repo, 'app.js');
    const text = fs.readFileSync(file, 'utf8').replace('module.exports = { login, footer, VERSION };', 'module.exports = { login };');
    const result = await analyzer.analyze(file, text);
    assert.strictEqual(result.conflicts.length, 2);
  });

  it('kaydedilmemiş değişikliği geri alınca çakışma kalkar', async () => {
    const file = path.join(repo, 'app.js');
    const text = fs.readFileSync(file, 'utf8').replace('© 2025', 'Copyright 2025');
    const result = await analyzer.analyze(file, text);
    assert.strictEqual(result.conflicts.length, 1);
  });

  it('main ile birebir aynı içerik çakışma üretmez', async () => {
    const file = path.join(repo, 'app.js');
    const { text } = await analyzer.mainText(repo, 'app.js');
    const result = await analyzer.analyze(file, text);
    assert.strictEqual(result.conflicts.length, 0);
  });
});
