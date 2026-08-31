import type { ClaudexConfig } from '../core/types.ts';

/**
 * The when-to-consult guidance, generated from the active policy rather than
 * shipped as a static file.
 *
 * ccx put this in a hand-written rules file that had no relationship to the
 * enforced budget, so the guidance and the reality drifted. Generating it means
 * the advice Claude reads matches the limits it will actually hit.
 */
export function renderSkill(config: ClaudexConfig): string {
  const { policy, budget } = config;
  const limit = budget.maxPerSession === -1 ? 'no fixed limit' : `${budget.maxPerSession} consults per session`;

  const triggers: Record<string, string[]> = {
    off: [],
    'on-request': [
      'The user explicitly asks for a second opinion, a review, or for Codex specifically.',
      'Two plausible designs have material tradeoffs that the repository does not settle.',
      'A serious debugging investigation is left with competing root causes, or a proposed fix has already failed once.',
      'You are about to finalize substantial self-authored work touching security, concurrency, persistence, migrations, public APIs, or spanning many files — use `codex_review`.',
    ],
    assisted: [
      'Everything under on-request, plus:',
      'Before any commit that changes more than a trivial amount of code.',
      'After two consecutive failed attempts at the same fix.',
      'Whenever a change touches authentication, credentials, or data migration.',
    ],
    aggressive: [
      'Everything under assisted, plus:',
      'Any non-trivial design decision, before you implement it.',
      'Any bug whose cause is not obvious within a couple of minutes of reading.',
    ],
  };

  const when = triggers[policy] ?? [];

  return `---
name: claudex
description: Consult Codex — a separate AI coding agent with its own independent view of this repository — for a second opinion, an adversarial review, or a delegated implementation. Use when a design choice has unresolved tradeoffs, a debugging investigation has competing root causes, a fix has already failed, or substantial work touching security, concurrency, persistence, or public APIs is about to be finalized.
---

# Consulting Codex

You have access to Codex through the \`claudex\` MCP server. Codex is a different model
from a different lab, reading this repository independently. Its value is precisely that
**it did not write the code and has no sunk cost in the approach it is checking**.

Current policy: **${policy}** (${limit}).

## When to spend a consult

${when.length === 0 ? 'Consultation is currently **disabled**. Do not call the claudex tools; answer on your own.' : when.map((t) => `- ${t}`).join('\n')}

## When not to

- Routine edits, refactors, and formatting.
- Facts you can verify yourself by reading the code or running a command.
- Confirming a conclusion you have already reached. If you are looking for agreement, do not ask.
- Immediately re-asking after a denial. A budget denial is final for the moment; keep working.

## How to ask well

Inspect the code and form your own position **first**. Then ask one narrow question that
contains the competing hypotheses or the concrete risk. A question like "what do you think
of this file?" wastes the call; "does the retry loop in queue.ts:41 admit a lost update when
two writers race?" gets you something usable.

Do not paste large excerpts — Codex reads the repository itself.

## What to do with the answer

Evaluate it; do not defer to it. Codex has less context than you about what the user actually
asked for, and it is sometimes confidently wrong. If you think it is wrong, say so and explain
why — use \`codex_reply\` with the thread id to make it defend the claim rather than accepting
or silently discarding it. Tell the user what Codex said and whether you agreed.

Default to **one consultation per task**. Continue a thread only for a specific unresolved
disagreement.

## Tools

- \`ask_codex\` — one narrow question. Read-only by default.
- \`codex_review\` — adversarial review, defaulting to the uncommitted changes. Returns a verdict.
- \`codex_reply\` — continue a thread by id. Cheap; pushing back is the intended use.
- \`codex_delegate\` — hand Codex a scoped implementation task. **Writes to the working tree.** Review the result yourself.
- \`codex_debate\` — two rounds: get Codex's independent answer, then have it attack yours.
- \`codex_budget\` — free. Check what is left before spending.
`;
}
