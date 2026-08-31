/** Permission the peer runs under. `read` is the default everywhere on purpose. */
export type Mode = 'read' | 'write' | 'full';

/** How eagerly Claude is expected to reach for Codex. */
export type Policy = 'off' | 'on-request' | 'assisted' | 'aggressive';

export type ConsultKind = 'ask' | 'review' | 'reply' | 'solve' | 'debate';

export interface Budget {
  /** Consults allowed per Claude session. 0 disables, -1 is unlimited. */
  maxPerSession: number;
  /** Minimum gap between consults, in ms. Blunts runaway loops. */
  cooldownMs: number;
  /** Kill timer for one peer invocation. Must be > 0 — see parseTimeout. */
  timeoutMs: number;
  /** Total peer wall-clock allowed per session, in ms. -1 is unlimited. */
  maxWallClockMs: number;
  /** Total peer output+reasoning tokens per session. -1 is unlimited.
   *  codex reports these on `turn.completed`, so unlike wall clock this
   *  tracks what the consult actually cost against the subscription. */
  maxTokens: number;
}

export interface ClaudexConfig {
  policy: Policy;
  budget: Budget;
  /** Default sandbox mode for consults that do not ask for one. */
  defaultMode: Mode;
  /** Model override handed to the peer CLI, or null for its default. */
  model: string | null;
  /** Command run on the host to produce evidence for the reviewer. */
  verifyCommand: string | null;
  /** Absolute path of the resolved project root. */
  projectRoot: string;
}

/** One completed (or failed) peer invocation. */
export interface ConsultResult {
  ok: boolean;
  kind: ConsultKind;
  threadId: string | null;
  content: string;
  /** Set when the answer is incomplete: we still return it, but flagged. */
  partial: 'timeout' | 'truncated' | null;
  durationMs: number;
  exitCode: number | null;
  stderr: string;
}

/** Structured refusal. Never an error — Claude should be able to reason about it. */
export interface BudgetDenial {
  denied: true;
  reason: 'policy-off' | 'session-limit' | 'cooldown' | 'wall-clock' | 'token-budget';
  message: string;
  /** ms until the same call would be allowed, when that is knowable. */
  retryAfterMs: number | null;
}

export interface ReviewVerdict {
  /** An unparseable verdict is `unknown`, never `approve`. Failing open here
   *  would end a review loop early on broken code. */
  verdict: 'approve' | 'changes-requested' | 'unknown';
  findings: string[];
}
