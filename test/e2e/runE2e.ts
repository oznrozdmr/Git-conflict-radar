import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// Yüklü VS Code ile eklentiyi gerçek editörde test eder:
//   VSCODE_PATH=/path/to/Code npm run test:e2e   (varsayılan: macOS'taki Visual Studio Code.app)
async function main() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcr-e2e-'));
  const repo = path.join(tmp, 'repo');
  execFileSync(path.join(root, 'scripts', 'make-test-repo.sh'), [repo]);

  try {
    await runTests({
      vscodeExecutablePath:
        process.env.VSCODE_PATH ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite'),
      launchArgs: [repo, '--disable-extensions', '--user-data-dir', path.join(tmp, 'user-data'), '--skip-welcome'],
      extensionTestsEnv: { GCR_TEST_REPO: repo },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
