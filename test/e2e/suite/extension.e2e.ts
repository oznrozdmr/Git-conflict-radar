import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

async function waitFor<T>(fn: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v !== undefined) {
      return v;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Zaman aşımı: ${what}`);
}

async function hoverText(uri: vscode.Uri, line: number): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    uri,
    new vscode.Position(line, 5),
  );
  return hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n')
    .replace(/&nbsp;/g, ' ');
}

function radarDiagnostics(uri: vscode.Uri) {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Git Conflict Radar');
}

describe('Git Conflict Radar (VS Code içinde)', () => {
  const file = vscode.Uri.file(path.join(process.env.GCR_TEST_REPO!, 'app.js'));
  let editor: vscode.TextEditor;

  before(async () => {
    editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  });

  it('çakışmaları task bilgisi ve tekrar düzenleme uyarısıyla raporlar', async () => {
    const diags = await waitFor(() => {
      const d = radarDiagnostics(file);
      return d.length === 2 ? d : undefined;
    }, '2 çakışma uyarısı');
    diags.sort((a, b) => a.range.start.line - b.range.start.line);

    assert.strictEqual(diags[0].range.start.line, 2);
    assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
    assert.match(diags[0].message, /PROJ-101/);
    assert.match(diags[0].message, /tekrar düzenleyin/);
    assert.strictEqual(diags[1].range.start.line, 8);
    assert.match(diags[1].message, /PROJ-150/);
  });

  it('hover içinde task, commit, yazar ve main değişikliğini gösterir', async () => {
    const text = await hoverText(file, 2);
    assert.match(text, /Çakışma riski — lütfen tekrar düzenleyin/);
    assert.match(text, /PROJ-101/);
    assert.match(text, /Ayşe Yılmaz/);
    assert.match(text, /login doğrulaması eklendi/);
    assert.match(text, /password\.length >= 8/);

    const footerText = await hoverText(file, 8);
    assert.match(footerText, /PROJ-150/);
    assert.match(footerText, /branch adından/);
  });

  it('kaydedilmemiş düzenlemeye göre güncellenir', async () => {
    const line = editor.document.lineAt(8);
    await editor.edit((e) => e.replace(line.range, "  return 'Copyright 2025';"));
    await waitFor(() => (radarDiagnostics(file).length === 1 ? true : undefined), 'çakışma sayısının 1e düşmesi');
    assert.ok(editor.document.isDirty);
  });

  it('main ile karşılaştırma görünümünü açar', async () => {
    await vscode.commands.executeCommand('gitConflictRadar.openDiffWithMain', file.toString());
    const left = await waitFor(
      () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'gcr-main'),
      'main içeriği',
    );
    assert.match(left.getText(), /Copyright 2026 Firma A\.Ş\./);
  });
});
