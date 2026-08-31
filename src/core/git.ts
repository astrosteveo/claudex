import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await git(['rev-parse', '--is-inside-work-tree'], cwd)).trim() === 'true';
}

/**
 * Describes what to review as a *target for the peer to read itself*, not as a
 * pasted diff. Codex has the repository; handing it a stale diff blob costs
 * tokens and invites it to review text instead of code.
 */
export async function describeTarget(cwd: string, explicit?: string | null): Promise<string> {
  if (explicit) return explicit;
  if (!(await isRepo(cwd))) return 'the current state of this working directory';

  const staged = (await git(['diff', '--cached', '--name-only'], cwd)).trim();
  const unstaged = (await git(['diff', '--name-only'], cwd)).trim();
  const untracked = (await git(['ls-files', '--others', '--exclude-standard'], cwd)).trim();

  const files = [...new Set([...staged.split('\n'), ...unstaged.split('\n'), ...untracked.split('\n')])].filter(Boolean);

  if (files.length > 0) {
    return [
      `the uncommitted changes in this repository. Run \`git diff HEAD\` and \`git status\` yourself to see them.`,
      `Files touched (${files.length}):`,
      ...files.slice(0, 60).map((f) => `  ${f}`),
      files.length > 60 ? `  …and ${files.length - 60} more` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
  return `the most recent commit on ${branch || 'HEAD'}. Run \`git show HEAD\` to see it.`;
}
