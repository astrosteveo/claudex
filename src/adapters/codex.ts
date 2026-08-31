import { spawn } from 'node:child_process';
import { CODEX_SANDBOX } from '../core/config.ts';
import type { ConsultKind, ConsultResult, Mode } from '../core/types.ts';

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export interface RunOptions {
  prompt: string;
  cwd: string;
  mode: Mode;
  kind: ConsultKind;
  timeoutMs: number;
  model?: string | null;
  /** Resume an existing Codex thread instead of starting cold. */
  threadId?: string | null;
  /** Path to a JSON Schema file constraining the final message. */
  outputSchemaPath?: string | null;
  signal?: AbortSignal;
  /** Called with streamed agent/reasoning text, for MCP progress notifications. */
  onProgress?: (note: string) => void;
}

export interface CodexRunResult extends ConsultResult {
  tokens: TokenUsage;
}

/** Events codex 0.151 emits under `--json`. Unknown types are ignored rather
 *  than treated as errors — the stream gains event types between releases. */
interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { id?: string; type?: string; text?: string; command?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string } | string;
  message?: string;
}

/**
 * Flags that `codex exec resume` does NOT accept, verified against 0.151:
 * `-s/--sandbox` and `-C/--cd` are rejected outright ("unexpected argument").
 * The sandbox has to be restated as a config override, and the working
 * directory can only come from the spawned process's own cwd. Getting this
 * wrong means a consult the caller asked to be read-only runs unsandboxed.
 */
function resumeSandboxFlags(mode: Mode): string[] {
  return ['-c', `sandbox_mode=${CODEX_SANDBOX[mode]}`];
}

export function buildArgs(opts: RunOptions): string[] {
  const args: string[] = ['exec'];

  if (opts.threadId) {
    args.push('resume', opts.threadId, ...resumeSandboxFlags(opts.mode));
  } else {
    args.push('-s', CODEX_SANDBOX[opts.mode], '-C', opts.cwd);
  }

  args.push('--json', '--skip-git-repo-check');
  if (opts.model) args.push('-m', opts.model);
  if (opts.outputSchemaPath) args.push('--output-schema', opts.outputSchemaPath);

  // Trailing `-` makes codex read the prompt from stdin. Never argv: Linux caps
  // a single argv entry at 128 KiB and a prompt carrying a diff blows past it.
  args.push('-');
  return args;
}

export async function runCodex(opts: RunOptions): Promise<CodexRunResult> {
  if (!(opts.timeoutMs > 0)) {
    // The kill timer is the only thing that reclaims a wedged peer CLI.
    throw new Error('claudex: timeoutMs must be positive');
  }

  const startedAt = Date.now();
  const args = buildArgs(opts);
  const child = spawn('codex', args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_MANAGED_BY_CLAUDEX: '1' },
  });

  let threadId: string | null = opts.threadId ?? null;
  let answer = '';
  let stderr = '';
  let tokens: TokenUsage = { ...ZERO_TOKENS };
  let streamError: string | null = null;
  let timedOut = false;
  let buffer = '';

  const finishAbort = (): void => {
    // The abort has to reach the spawned peer. Without this an Esc in the host
    // leaves a codex process running and, in write mode, still editing files.
    if (!child.killed) child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 2000).unref();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    finishAbort();
  }, opts.timeoutMs);

  const onAbort = (): void => finishAbort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const handleEvent = (evt: CodexEvent): void => {
    switch (evt.type) {
      case 'thread.started':
        if (evt.thread_id) threadId = evt.thread_id;
        break;
      case 'item.completed': {
        const item = evt.item;
        if (!item) break;
        if (item.type === 'agent_message' && item.text) {
          answer += (answer ? '\n\n' : '') + item.text;
          opts.onProgress?.(item.text.slice(0, 200));
        } else if (item.type === 'reasoning' && item.text) {
          opts.onProgress?.(item.text.slice(0, 200));
        } else if (item.type === 'command_execution' && item.command) {
          opts.onProgress?.(`$ ${item.command.slice(0, 160)}`);
        }
        break;
      }
      case 'turn.completed': {
        const u = evt.usage;
        if (u) {
          tokens = {
            inputTokens: tokens.inputTokens + (u.input_tokens ?? 0),
            cachedInputTokens: tokens.cachedInputTokens + (u.cached_input_tokens ?? 0),
            outputTokens: tokens.outputTokens + (u.output_tokens ?? 0),
            reasoningTokens: tokens.reasoningTokens + (u.reasoning_output_tokens ?? 0),
          };
        }
        break;
      }
      case 'turn.failed':
      case 'error': {
        const e = evt.error;
        streamError = typeof e === 'string' ? e : (e?.message ?? evt.message ?? 'codex reported an error');
        break;
      }
      default:
        break;
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
        handleEvent(JSON.parse(line) as CodexEvent);
      } catch {
        // Non-JSON lines are progress chatter from a newer codex; ignore.
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // Bounded: a peer that fails in a loop must not grow this without limit.
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

  // Flush a trailing line with no newline.
  if (buffer.trim()) {
    try {
      handleEvent(JSON.parse(buffer.trim()) as CodexEvent);
    } catch {
      /* ignore */
    }
  }

  const durationMs = Date.now() - startedAt;

  // A timed-out peer returns its partial output *flagged*, never as a clean
  // answer, and a timeout with nothing to salvage fails. Returning a
  // half-answer unflagged would defeat every review gate downstream.
  if (timedOut) {
    return {
      ok: answer.length > 0,
      kind: opts.kind,
      threadId,
      content: answer,
      partial: 'timeout',
      durationMs,
      exitCode,
      stderr: stderr.trim(),
      tokens,
    };
  }

  const ok = exitCode === 0 && streamError === null && answer.length > 0;
  return {
    ok,
    kind: opts.kind,
    threadId,
    content: answer || (streamError ?? ''),
    partial: null,
    durationMs,
    exitCode,
    stderr: stderr.trim(),
    tokens,
  };
}
