import * as vscode from 'vscode';
import { AnalysisResult } from './analyzer';
import { conflictLines, formatDate, taskSourceText, taskUrl, theirsDiff } from './format';

export class ConflictHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly getResult: (uri: vscode.Uri) => AnalysisResult | undefined,
    private readonly getTaskUrlTemplate: () => string,
  ) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const result = this.getResult(document.uri);
    if (!result) {
      return undefined;
    }
    const conflict = result.conflicts.find((c) => {
      const { start, end } = conflictLines(c, document.lineCount);
      return position.line >= start && position.line <= end;
    });
    if (!conflict) {
      return undefined;
    }

    const { start, end } = conflictLines(conflict, document.lineCount);
    const mainRef = result.refs.mainRef;
    const template = this.getTaskUrlTemplate();
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['gitConflictRadar.openDiffWithMain', 'gitConflictRadar.refresh'] };

    md.appendMarkdown('### $(warning) Çakışma riski — lütfen tekrar düzenleyin\n\n');
    md.appendText(
      `Bu satırlar siz çalışırken ${mainRef} dalında da değiştirildi. Merge sırasında çakışma çıkması muhtemel; ` +
        `main'deki değişikliği inceleyip kendi değişikliğinizi ona göre yeniden düzenleyin.`,
    );
    md.appendMarkdown('\n\n---\n\n');

    if (conflict.commits.length === 0) {
      md.appendText('Değişikliği yapan commit bulunamadı.');
      md.appendMarkdown('\n\n');
    }
    for (const c of conflict.commits) {
      const url = c.taskId ? taskUrl(c.taskId, template) : undefined;
      md.appendMarkdown('**Task: ');
      if (c.taskId && url) {
        md.appendMarkdown(`[${escape(c.taskId)}](${url})`);
      } else {
        md.appendText(c.taskId ?? 'bulunamadı');
      }
      md.appendMarkdown('** · ');
      md.appendMarkdown(`\`${c.shortSha}\` · `);
      md.appendText(`${c.author} · ${formatDate(c.time)}`);
      md.appendMarkdown('\n\n> ');
      md.appendText(c.subject);
      md.appendMarkdown('\n\n');
      const source = taskSourceText(c);
      if (source) {
        md.appendMarkdown('_');
        md.appendText(source);
        md.appendMarkdown('_\n\n');
      }
    }
    if (conflict.approximate) {
      md.appendMarkdown('_');
      md.appendText(`main'de satırlar silindiği için commit'ler bu dosyaya dokunan son değişikliklerden tahmin edildi.`);
      md.appendMarkdown('_\n\n');
    }

    const diff = theirsDiff(conflict);
    if (diff) {
      md.appendMarkdown(`**${escape(mainRef)}'de yapılan değişiklik:**\n`);
      md.appendCodeblock(diff, 'diff');
    }

    const diffArgs = encodeURIComponent(JSON.stringify([document.uri.toString()]));
    md.appendMarkdown(
      `\n[$(git-compare) main ile karşılaştır](command:gitConflictRadar.openDiffWithMain?${diffArgs})` +
        ` · [$(refresh) Yenile](command:gitConflictRadar.refresh)`,
    );

    return new vscode.Hover(md, new vscode.Range(start, 0, end, document.lineAt(end).text.length));
  }
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}
