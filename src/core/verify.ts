import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VerifyResult {
  ran: boolean;
  passed: boolean;
  command: string | null;
  output: string;
}

/**
 * Runs the project's verify command **on the host**, never inside the peer's
 * sandbox.
 *
 * Inside Codex's sandbox (any `-s` mode) Node reports a spurious EPERM from
 * every child spawn even when the child runs correctly. `node --test` spawns a
 * process per test file, so a fully passing suite reports itself as failing. A
 * sandboxed peer's account of a test run is therefore not evidence, and handing
 * the reviewer that account would make it reject working code. We run the
 * command ourselves and hand it the real result.
 */
export async function runVerify(command: string | null, cwd: string, timeoutMs = 600_000): Promise<VerifyResult> {
  if (!command) return { ran: false, passed: false, command: null, output: '' };
  try {
    const { stdout, stderr } = await execFileAsync(command, {
      cwd,
      shell: true,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ran: true, passed: true, command, output: tail(stdout + stderr) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ran: true,
      passed: false,
      command,
      output: tail((e.stdout ?? '') + (e.stderr ?? '') || (e.message ?? 'verify command failed')),
    };
  }
}

/** Reviewers need the failure, not the scrollback. */
function tail(s: string, limit = 8000): string {
  const t = s.trimEnd();
  return t.length <= limit ? t : `…(truncated)…\n${t.slice(-limit)}`;
}

export function formatEvidence(v: VerifyResult): string | null {
  if (!v.ran) return null;
  return `$ ${v.command}\nresult: ${v.passed ? 'PASS' : 'FAIL'}\n${v.output}`;
}
