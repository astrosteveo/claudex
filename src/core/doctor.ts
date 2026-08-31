import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

async function tryExec(cmd: string, args: string[], timeout = 20_000): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout, maxBuffer: 1024 * 1024 });
    return { ok: true, out: (stdout + stderr).trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: ((e.stdout ?? '') + (e.stderr ?? '') || (e.message ?? '')).trim() };
  }
}

export async function checkCodexInstalled(): Promise<Check> {
  const r = await tryExec('codex', ['--version']);
  if (!r.ok) {
    return {
      name: 'codex CLI',
      status: 'fail',
      detail: 'not found on PATH',
      fix: 'Install Codex: https://developers.openai.com/codex/cli',
    };
  }
  return { name: 'codex CLI', status: 'ok', detail: r.out.split('\n')[0] ?? r.out };
}

/**
 * claudex is explicitly for people who pay for both products. An API-key login
 * still works, but it bills per token instead of drawing on the subscription,
 * so it is worth naming rather than silently passing.
 */
export async function checkCodexAuth(): Promise<Check> {
  const r = await tryExec('codex', ['login', 'status']);
  const out = r.out;
  if (!r.ok || /not logged in/i.test(out)) {
    return { name: 'codex auth', status: 'fail', detail: out || 'not logged in', fix: 'Run: codex login' };
  }
  if (/api key/i.test(out)) {
    return {
      name: 'codex auth',
      status: 'warn',
      detail: `${out} — billed per token, not against a ChatGPT subscription`,
      fix: 'Run `codex login` to use your subscription instead.',
    };
  }
  return { name: 'codex auth', status: 'ok', detail: out };
}

export async function checkClaudeInstalled(): Promise<Check> {
  const r = await tryExec('claude', ['--version']);
  if (!r.ok) {
    return {
      name: 'claude CLI',
      status: 'warn',
      detail: 'not found on PATH',
      fix: 'Install Claude Code: https://claude.com/claude-code — needed for `claudex install`.',
    };
  }
  return { name: 'claude CLI', status: 'ok', detail: r.out.split('\n')[0] ?? r.out };
}

export function checkClaudeAuth(): Check {
  // There is no `claude auth status`; the credential file is the observable.
  const candidates = [join(homedir(), '.claude', '.credentials.json'), join(homedir(), '.claude.json')];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    return {
      name: 'claude auth',
      status: 'warn',
      detail: 'no Claude Code credentials found',
      fix: 'Run `claude` once and sign in.',
    };
  }
  return { name: 'claude auth', status: 'ok', detail: `credentials present (${found})` };
}

/**
 * Confirms `sandbox_mode` is still a real config key.
 *
 * `codex exec resume` rejects `-s`, so a resumed consult can only be sandboxed
 * via `-c sandbox_mode=…`. If that key is ever renamed, the override becomes a
 * silent no-op and a consult the caller asked to be read-only runs unsandboxed.
 * That is a security regression that produces no error, so it gets a check.
 */
export async function checkSandboxKey(): Promise<Check> {
  const r = await tryExec('codex', ['exec', '--strict-config', '-c', 'sandbox_mode=read-only', '--help']);
  if (!r.ok && /unknown|unrecognized|not recognized/i.test(r.out)) {
    return {
      name: 'sandbox override',
      status: 'fail',
      detail: '`-c sandbox_mode=` is no longer accepted by this codex build',
      fix: 'Resumed consults cannot be sandboxed. Upgrade or downgrade codex, or open a claudex issue.',
    };
  }
  return { name: 'sandbox override', status: 'ok', detail: '`-c sandbox_mode=` accepted (resume path is sandboxed)' };
}

export async function checkResumeFlags(): Promise<Check> {
  const r = await tryExec('codex', ['exec', 'resume', '--help']);
  if (!r.ok) return { name: 'resume flags', status: 'warn', detail: 'could not inspect `codex exec resume --help`' };
  const acceptsSandbox = /--sandbox/.test(r.out);
  if (acceptsSandbox) {
    return {
      name: 'resume flags',
      status: 'warn',
      detail: '`codex exec resume` now accepts --sandbox; claudex still uses the -c override (harmless)',
    };
  }
  return { name: 'resume flags', status: 'ok', detail: '`codex exec resume` takes no --sandbox, as claudex assumes' };
}

export function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < 20) {
    return { name: 'node', status: 'fail', detail: `node ${process.versions.node}`, fix: 'claudex needs Node >= 20.11.' };
  }
  return { name: 'node', status: 'ok', detail: `node ${process.versions.node}` };
}

export async function runDoctor(): Promise<Check[]> {
  const codex = await checkCodexInstalled();
  const checks: Check[] = [checkNode(), codex];
  if (codex.status === 'ok') {
    checks.push(await checkCodexAuth(), await checkSandboxKey(), await checkResumeFlags());
  }
  checks.push(await checkClaudeInstalled(), checkClaudeAuth());
  return checks;
}

export function worstStatus(checks: Check[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}
