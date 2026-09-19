import * as vscode from 'vscode';
import { AnalysisResult } from './analyzer';
import { conflictLines, conflictTasks } from './format';

export class ConflictDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('gitConflictRadar');

  set(document: vscode.TextDocument, result: AnalysisResult): void {
    const diagnostics = result.conflicts.map((c) => {
      const { start, end } = conflictLines(c, document.lineCount);
      const who = c.commits[0] ? ` (${c.commits[0].author}: "${c.commits[0].subject}")` : '';
      const d = new vscode.Diagnostic(
        new vscode.Range(start, 0, end, document.lineAt(end).text.length),
        `Bu satırlar ${result.refs.mainRef}'de ${conflictTasks(c)}${who} ile değiştirildi. ` +
          `Lütfen main'deki değişikliğe göre tekrar düzenleyin.`,
        vscode.DiagnosticSeverity.Warning,
      );
      d.source = 'Git Conflict Radar';
      d.code = c.commits.find((x) => x.taskId)?.taskId;
      return d;
    });
    this.collection.set(document.uri, diagnostics);
  }

  delete(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
