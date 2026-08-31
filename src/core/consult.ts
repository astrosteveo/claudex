import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KIND_TIMEOUT_MULTIPLIER } from './config.ts';
import { runCodex, type CodexRunResult } from '../adapters/codex.ts';
import { BudgetGovernor, newUsage, type SessionUsage } from './budget.ts';
import { ConsultLog } from './log.ts';
import { describeTarget } from './git.ts';
import { formatEvidence, runVerify } from './verify.ts';
import {
  PEER_FOOTER,
  REVIEW_SCHEMA,
  askPrompt,
  critiquePrompt,
  debatePrompt,
  implementPrompt,
  parseVerdict,
  reviewPrompt,
} from './prompts.ts';
import type { BudgetDenial, ClaudexConfig, ConsultKind, Mode, ReviewVerdict } from './types.ts';

export interface ConsultRequest {
  mode?: Mode;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
}

export interface ConsultResponse {
  ok: boolean;
  denied?: BudgetDenial;
  content: string;
  threadId: string | null;
  partial: string | null;
  durationMs: number;
  tokens: number;
  /** What the caller has left, so it can pace itself without asking. */
  budgetRemaining: number | 'unlimited';
}

function withSchemaFile<T>(schema: unknown, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'claudex-'));
  const path = join(dir, 'schema.json');
  writeFileSync(path, JSON.stringify(schema), 'utf8');
  return fn(path).finally(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
}

export class ConsultService {
  readonly governor: BudgetGovernor;
  readonly #log: ConsultLog;
  readonly #config: ClaudexConfig;

  constructor(config: ClaudexConfig, sessionId: string = randomUUID(), usage: SessionUsage = newUsage(sessionId)) {
    this.#config = config;
    this.governor = new BudgetGovernor(config.budget, usage);
    this.#log = new ConsultLog(config.projectRoot);
  }

  get usage(): SessionUsage {
    return this.governor.snapshot;
  }

  #remaining(): number | 'unlimited' {
    const r = this.governor.remaining();
    return r === Infinity ? 'unlimited' : r;
  }

  #denial(d: BudgetDenial, kind: ConsultKind, mode: Mode): ConsultResponse {
    this.#log.append({
      ts: Date.now(),
      sessionId: this.usage.sessionId,
      kind,
      mode,
      ok: false,
      denied: d.reason,
      partial: null,
      durationMs: 0,
      threadId: null,
      promptChars: 0,
      answerChars: 0,
    });
    return {
      ok: false,
      denied: d,
      content: d.message,
      threadId: null,
      partial: null,
      durationMs: 0,
      tokens: 0,
      budgetRemaining: this.#remaining(),
    };
  }

  /** Single funnel: every peer invocation is budgeted, logged, and footered. */
  async #invoke(
    kind: ConsultKind,
    prompt: string,
    req: ConsultRequest,
    opts: { threadId?: string | null; outputSchema?: unknown; footer?: boolean } = {},
  ): Promise<ConsultResponse> {
    const mode = req.mode ?? this.#config.defaultMode;

    // Reserve before awaiting anything: parallel tool calls must not all pass
    // the same check. See BudgetGovernor.reserve.
    const denied = this.governor.reserve();
    if (denied) return this.#denial(denied, kind, mode);

    const timeoutMs =
      req.timeoutMs && req.timeoutMs > 0
        ? req.timeoutMs
        : Math.round(this.#config.budget.timeoutMs * KIND_TIMEOUT_MULTIPLIER[kind]);

    const run = (schemaPath: string | null): Promise<CodexRunResult> =>
      runCodex({
        prompt,
        cwd: this.#config.projectRoot,
        mode,
        kind,
        timeoutMs,
        model: this.#config.model,
        threadId: opts.threadId ?? null,
        outputSchemaPath: schemaPath,
        signal: req.signal,
        onProgress: req.onProgress,
      });

    let result: CodexRunResult;
    try {
      result = opts.outputSchema ? await withSchemaFile(opts.outputSchema, (p) => run(p)) : await run(null);
    } catch (err) {
      // The peer was never actually invoked (a bad timeout, a spawn that threw
      // before starting), so the reserved slot goes back.
      this.governor.release();
      throw err;
    }

    const spentTokens = result.tokens.outputTokens + result.tokens.reasoningTokens;
    this.governor.settle(kind, result.durationMs, spentTokens);
    this.#log.append({
      ts: Date.now(),
      sessionId: this.usage.sessionId,
      kind,
      mode,
      ok: result.ok,
      denied: null,
      partial: result.partial,
      durationMs: result.durationMs,
      threadId: result.threadId,
      promptChars: prompt.length,
      answerChars: result.content.length,
    });
    this.#log.writeUsage(this.usage);

    let content = result.content;
    if (result.partial === 'timeout') {
      content =
        content.length > 0
          ? `[INCOMPLETE — Codex hit the ${Math.round(timeoutMs / 1000)}s timeout. This is a partial answer; do not treat it as a conclusion.]\n\n${content}`
          : `Codex hit the ${Math.round(timeoutMs / 1000)}s timeout with nothing to salvage.`;
    } else if (!result.ok) {
      content = content || `Codex failed (exit ${String(result.exitCode)}).${result.stderr ? `\n${result.stderr}` : ''}`;
    }

    // Only a real answer gets the footer. Appending "evaluate this argument" to
    // a transport error frames a failure as an opinion.
    if (opts.footer !== false && result.ok) content += PEER_FOOTER;

    return {
      ok: result.ok,
      content,
      threadId: result.threadId,
      partial: result.partial,
      durationMs: result.durationMs,
      tokens: spentTokens,
      budgetRemaining: this.#remaining(),
    };
  }

  ask(question: string, context: string | null, req: ConsultRequest = {}): Promise<ConsultResponse> {
    const mode = req.mode ?? this.#config.defaultMode;
    return this.#invoke('ask', askPrompt(question, mode, context), req);
  }

  reply(threadId: string, message: string, req: ConsultRequest = {}): Promise<ConsultResponse> {
    return this.#invoke('reply', message, req, { threadId });
  }

  async review(
    target: string | null,
    req: ConsultRequest = {},
  ): Promise<ConsultResponse & { verdict: ReviewVerdict }> {
    const mode = req.mode ?? this.#config.defaultMode;

    // Peek at the budget before doing any work. The verify command below is a
    // full test suite; running it only to be told the budget is spent wastes
    // more of the user's time than the consult would have.
    const blocked = this.governor.check();
    if (blocked) {
      return { ...this.#denial(blocked, 'review', mode), verdict: { verdict: 'unknown', findings: [] } };
    }

    const described = await describeTarget(this.#config.projectRoot, target);

    // Run the verify command here on the host — see verify.ts for why a
    // sandboxed peer's own test run is not admissible evidence.
    const verify = await runVerify(this.#config.verifyCommand, this.#config.projectRoot);

    const res = await this.#invoke('review', reviewPrompt(described, mode, formatEvidence(verify)), req, {
      outputSchema: REVIEW_SCHEMA,
    });
    return { ...res, verdict: res.ok ? parseVerdict(res.content) : { verdict: 'unknown', findings: [] } };
  }

  implement(plan: string, req: ConsultRequest = {}): Promise<ConsultResponse> {
    const mode = req.mode ?? 'write';
    return this.#invoke('solve', implementPrompt(plan, mode), { ...req, mode });
  }

  debateOpen(question: string, req: ConsultRequest = {}): Promise<ConsultResponse> {
    const mode = req.mode ?? this.#config.defaultMode;
    return this.#invoke('debate', debatePrompt(question, mode), req);
  }

  debateCritique(threadId: string, question: string, otherAnswer: string, req: ConsultRequest = {}): Promise<ConsultResponse> {
    return this.#invoke('debate', critiquePrompt(question, otherAnswer), req, { threadId });
  }
}
