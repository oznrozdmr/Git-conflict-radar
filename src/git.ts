import { execFile } from 'child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** git komutunu çalıştırır ve stdout'u döndürür; sıfır dışı çıkış kodunda GitError fırlatır. */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
          // Arka plandaki fetch/ls-remote asla şifre ya da SSH onayı bekleyip takılmasın.
          GIT_TERMINAL_PROMPT: '0',
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new GitError(`git ${args[0]} başarısız: ${stderr.trim() || err.message}`, stderr));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** Hata yerine undefined döndüren git çağrısı. */
export async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}
