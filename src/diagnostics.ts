import * as vscode from 'vscode';
import { AnalysisResult } from './analyzer';
import { conflictLines, conflictTasks } from './format';

/** Açık bir belge ya da diskten okunmuş bir metin için satır bilgisi. */
export interface LineSource {
  lineCount: number;
  lineLength(line: number): number;
}

export function linesOfDocument(doc: vscode.TextDocument): LineSource {
  return { lineCount: doc.lineCount, lineLength: (i) => doc.lineAt(i).text.length };
}

export function linesOfText(text: string): LineSource {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return { lineCount: lines.length, lineLength: (i) => lines[i]?.length ?? 0 };
}

export class ConflictDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('gitConflictRadar');

  set(uri: vscode.Uri, lines: LineSource, result: AnalysisResult): void {
    const diagnostics = result.conflicts.map((c) => {
      const { start, end } = conflictLines(c, lines.lineCount);
      const who = c.commits[0] ? ` (${c.commits[0].author}: "${c.commits[0].subject}")` : '';
      const d = new vscode.Diagnostic(
        new vscode.Range(start, 0, end, lines.lineLength(end)),
        `Bu satırlar ${result.refs.mainRef}'de ${conflictTasks(c)}${who} ile değiştirildi. ` +
          `Lütfen main'deki değişikliğe göre tekrar düzenleyin.`,
        vscode.DiagnosticSeverity.Warning,
      );
      d.source = 'Git Conflict Radar';
      d.code = c.commits.find((x) => x.taskId)?.taskId;
      return d;
    });
    this.collection.set(uri, diagnostics);
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
