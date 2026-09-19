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
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
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
