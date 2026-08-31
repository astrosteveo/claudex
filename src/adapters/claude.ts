import { spawn } from 'node:child_process';
import type { ConsultKind, ConsultResult, Mode } from '../core/types.ts';

/**
 * Drives Claude Code headlessly, for the `solve` and `debate` commands a human
 * runs from the shell. The MCP path never touches this file — there, Claude is
 * already the caller.
 */

/** Verified: `--output-format stream-json` refuses to run without `--verbose`. */
const STREAM_FLAGS = ['--output-format', 'stream-json', '--verbose'];

const PERMISSION_MODE: Record<Mode, string> = {
  read: 'plan',
  write: 'acceptEdits',
  full: 'bypassPermissions',
};

export interface ClaudeRunOptions {
  prompt: string;
  cwd: string;
  mode: Mode;
  kind: ConsultKind;
  timeoutMs: number;
  model?: string | null;
  sessionId?: string | null;
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
}

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: { content?: { type?: string; text?: string }[] };
}

export function buildClaudeArgs(opts: ClaudeRunOptions): string[] {
  const args = ['-p', ...STREAM_FLAGS, '--permission-mode', PERMISSION_MODE[opts.mode]];
  if (opts.model) args.push('--model', opts.model);
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  return args;
}

export async function runClaude(opts: ClaudeRunOptions): Promise<ConsultResult> {
  if (!(opts.timeoutMs > 0)) throw new Error('claudex: timeoutMs must be positive');

  const startedAt = Date.now();
  const child = spawn('claude', buildClaudeArgs(opts), { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });

  let sessionId: string | null = opts.sessionId ?? null;
  let answer = '';
  let streamed = '';
  let stderr = '';
  let isError = false;
  let timedOut = false;
  let buffer = '';

  const abort = (): void => {
    if (!child.killed) child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 2000).unref();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, opts.timeoutMs);
  const onAbort = (): void => abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const handle = (evt: ClaudeEvent): void => {
    if (evt.session_id) sessionId = evt.session_id;
    if (evt.type === 'assistant') {
      // Streamed assistant text is what makes progress reporting and partial
      // salvage on timeout possible; the final `result` event may never arrive.
      for (const block of evt.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          streamed += (streamed ? '\n' : '') + block.text;
          opts.onProgress?.(block.text.slice(0, 200));
        }
      }
    } else if (evt.type === 'result') {
      if (typeof evt.result === 'string') answer = evt.result;
      if (evt.is_error) isError = true;
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line) as ClaudeEvent);
      } catch {
        /* ignore non-JSON chatter */
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 16_384) stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.once('error', (err: Error) => {
      stderr += `\n${err.message}`;
      resolveExit(null);
    });
    child.once('close', (code) => resolveExit(code));
    child.stdin.end(opts.prompt);
  });

  clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onAbort);

  const durationMs = Date.now() - startedAt;
  const content = answer || streamed;

  if (timedOut) {
    return {
      ok: content.length > 0,
      kind: opts.kind,
      threadId: sessionId,
      content,
      partial: 'timeout',
      durationMs,
      exitCode,
      stderr: stderr.trim(),
    };
  }

  return {
    ok: exitCode === 0 && !isError && content.length > 0,
    kind: opts.kind,
    threadId: sessionId,
    content,
    partial: null,
    durationMs,
    exitCode,
    stderr: stderr.trim(),
  };
}
