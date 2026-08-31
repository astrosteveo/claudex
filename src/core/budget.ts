import type { Budget, BudgetDenial, ConsultKind } from './types.ts';

export interface SessionUsage {
  sessionId: string;
  startedAt: number;
  consults: number;
  wallClockMs: number;
  tokens: number;
  lastConsultAt: number | null;
  byKind: Record<string, number>;
}

export function newUsage(sessionId: string): SessionUsage {
  return { sessionId, startedAt: Date.now(), consults: 0, wallClockMs: 0, tokens: 0, lastConsultAt: null, byKind: {} };
}

const UNLIMITED = -1;

/**
 * The governor. Every peer invocation passes through `check` first.
 *
 * It returns a structured denial rather than throwing, because the caller is a
 * language model: "you have used your 12 consults, here is when the next is
 * allowed" is something it can plan around, where an exception is just noise it
 * will retry into.
 */
export class BudgetGovernor {
  readonly #budget: Budget;
  #usage: SessionUsage;
  readonly #now: () => number;

  constructor(budget: Budget, usage: SessionUsage, now: () => number = Date.now) {
    this.#budget = budget;
    this.#usage = usage;
    this.#now = now;
  }

  get snapshot(): SessionUsage {
    return { ...this.#usage, byKind: { ...this.#usage.byKind } };
  }

  remaining(): number {
    if (this.#budget.maxPerSession === UNLIMITED) return Infinity;
    return Math.max(0, this.#budget.maxPerSession - this.#usage.consults);
  }

  /**
   * Reserves a consult slot, or refuses.
   *
   * Reserving and settling are separate because an MCP server handles calls
   * concurrently: a client may fire several tool calls in one turn. If the
   * count were only incremented on completion, every one of those calls would
   * pass the check before any of them recorded, and the session would blow
   * straight through maxPerSession. The slot is therefore taken up front and
   * only the measured cost is added later.
   */
  reserve(): BudgetDenial | null {
    const denial = this.check();
    if (denial) return denial;
    this.#usage = {
      ...this.#usage,
      consults: this.#usage.consults + 1,
      lastConsultAt: this.#now(),
    };
    return null;
  }

  /** Adds the measured cost of a reserved consult. Charged even on failure: a
   *  peer that burned the clock and timed out cost what it cost. */
  settle(kind: ConsultKind, durationMs: number, tokens = 0): void {
    this.#usage = {
      ...this.#usage,
      wallClockMs: this.#usage.wallClockMs + Math.max(0, durationMs),
      tokens: this.#usage.tokens + Math.max(0, tokens),
      byKind: { ...this.#usage.byKind, [kind]: (this.#usage.byKind[kind] ?? 0) + 1 },
    };
  }

  /** Returns a slot taken by a reservation that never reached the peer. */
  release(): void {
    this.#usage = { ...this.#usage, consults: Math.max(0, this.#usage.consults - 1) };
  }

  check(): BudgetDenial | null {
    const { maxPerSession, cooldownMs, maxWallClockMs, maxTokens } = this.#budget;

    if (maxPerSession === 0) {
      return {
        denied: true,
        reason: 'policy-off',
        message:
          'Codex consultation is disabled for this project (policy "off", or maxPerSession 0). ' +
          'Enable it with `claudex policy set on-request`. Do not retry; answer without the peer.',
        retryAfterMs: null,
      };
    }

    if (maxPerSession !== UNLIMITED && this.#usage.consults >= maxPerSession) {
      return {
        denied: true,
        reason: 'session-limit',
        message:
          `Codex consult budget for this session is spent (${this.#usage.consults}/${maxPerSession}). ` +
          'Do not retry; finish the work on your own judgement, and tell the user they can raise the ' +
          'limit with `claudex policy budget --max-per-session <n>` if a second opinion is worth it here.',
        retryAfterMs: null,
      };
    }

    if (maxWallClockMs !== UNLIMITED && this.#usage.wallClockMs >= maxWallClockMs) {
      return {
        denied: true,
        reason: 'wall-clock',
        message:
          `Codex has already run for ${Math.round(this.#usage.wallClockMs / 1000)}s this session, at or over the ` +
          `${Math.round(maxWallClockMs / 1000)}s cap. Do not retry; proceed without the peer.`,
        retryAfterMs: null,
      };
    }

    if (maxTokens !== UNLIMITED && this.#usage.tokens >= maxTokens) {
      return {
        denied: true,
        reason: 'token-budget',
        message:
          `Codex has spent ${this.#usage.tokens} tokens this session, at or over the ${maxTokens} cap. ` +
          'Do not retry; proceed without the peer.',
        retryAfterMs: null,
      };
    }

    if (cooldownMs > 0 && this.#usage.lastConsultAt !== null) {
      const elapsed = this.#now() - this.#usage.lastConsultAt;
      if (elapsed < cooldownMs) {
        const retryAfterMs = cooldownMs - elapsed;
        return {
          denied: true,
          reason: 'cooldown',
          message:
            `Another Codex consult is available in ${Math.ceil(retryAfterMs / 1000)}s (cooldown ${Math.round(
              cooldownMs / 1000,
            )}s). Keep working; ask again later only if it still matters.`,
          retryAfterMs,
        };
      }
    }

    return null;
  }

}
