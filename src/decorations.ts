import * as vscode from 'vscode';
import { Conflict } from './analyzer';
import { conflictLines, conflictTasks } from './format';

export class ConflictDecorations implements vscode.Disposable {
  private readonly highlight: vscode.TextEditorDecorationType;
  private readonly label: vscode.TextEditorDecorationType;

  constructor(context: vscode.ExtensionContext) {
    this.highlight = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('gitConflictRadar.conflictBackground'),
      overviewRulerColor: new vscode.ThemeColor('gitConflictRadar.conflictRuler'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      gutterIconPath: context.asAbsolutePath('media/conflict.svg'),
      gutterIconSize: 'contain',
    });
    this.label = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 2em',
        color: new vscode.ThemeColor('editorWarning.foreground'),
        fontStyle: 'italic',
      },
    });
  }

  apply(editor: vscode.TextEditor, conflicts: Conflict[], mainRef: string): void {
    const doc = editor.document;
    const highlights: vscode.Range[] = [];
    const labels: vscode.DecorationOptions[] = [];

    for (const c of conflicts) {
      const { start, end } = conflictLines(c, doc.lineCount);
      highlights.push(new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
      const eol = doc.lineAt(start).range.end;
      labels.push({
        range: new vscode.Range(eol, eol),
        renderOptions: {
          after: { contentText: `⚠ ${mainRef}'de değişti: ${conflictTasks(c)} — tekrar düzenleyin` },
        },
      });
    }
    editor.setDecorations(this.highlight, highlights);
    editor.setDecorations(this.label, labels);
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.highlight, []);
    editor.setDecorations(this.label, []);
  }

  dispose(): void {
    this.highlight.dispose();
    this.label.dispose();
  }
}
