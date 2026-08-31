# CLAUDE.md

Guidance for Claude Code working in this repository.

## Commands

```bash
npm test                                     # build, then the whole suite
npm run test:only                            # suite without rebuilding
node --test test/budget.test.ts              # one file
node --test --test-name-pattern 'cooldown'   # one test by name
npm run typecheck                            # tsc --noEmit
npm run build                                # tsup -> dist/cli.js, dist/mcp-server.js

node dist/cli.js doctor                      # verify both CLIs against the assumptions below
```

`test/mcp-server.test.ts` runs against `dist/`, so **build before running it alone** —
`npm run test:only` on a stale `dist/` tests the previous version.

## Architecture

Claude Code is wired to consult an authenticated Codex, in one direction, through a budget.

**`src/adapters/`** normalise each CLI to a shared vocabulary — `buildArgs()` + `run()`.
`codex.ts` is the one the MCP path uses; `claude.ts` exists only for the `solve` and `debate`
CLI commands, where a human is driving and Claude is not already the caller.

**`src/core/consult.ts` is the single funnel.** Every peer invocation goes through
`ConsultService.#invoke`, which reserves budget, spawns, settles the measured cost, logs, and
appends the peer footer. Nothing should call `runCodex` directly.

**`src/core/budget.ts` is the governor** — the thing that makes this more than a pipe. It
returns structured denials rather than throwing, because the caller is a language model:
"you have spent your 12 consults" is something it can plan around, where an exception is
noise it retries into.

**`src/core/prompts.ts` holds all agent-facing wording**, including `parseVerdict()`. Prompt
changes belong there, not inline at call sites.

**`src/cli/skill.ts` generates the when-to-consult guidance from the active policy.** It is
generated rather than shipped static so the advice Claude reads matches the limits it will
actually hit.

**There are two distribution surfaces over one codebase.** The npm package (`@astrosteveo/claudex`;
the bin is still `claudex`) is the engine, and `.claude-plugin/` wraps it so `/plugin install`
registers the MCP server and the skill together. The plugin manifest pins the package version, so
bumping `package.json` means bumping `.claude-plugin/plugin.json` with it.

**`skills/claudex/SKILL.md` is a generated artifact that is checked in.** It is the policy-agnostic
copy the plugin ships; `claudex install` writes a policy-specific one to `~/.claude/skills/`.
Editing the checked-in file by hand is wrong — change `renderSkill()` and regenerate, or the two
copies drift.

**`.claudex/config.json` is committed; everything else under `.claudex/` is not.** Project policy
outranks user policy precisely so a repo can bind everyone working in it, which only works if it
is in the tree. The consult log, session usage, and run transcripts beside it are per-run state
and stay ignored.

**Permission modes (`read`/`write`/`full`) are config, not hardcoded** — `CODEX_SANDBOX` in
`src/core/config.ts`. Codex moves its flag surface between releases; a mode should be
retargetable without touching adapter code.

## Invariants that will bite you

Established against codex 0.151 and Claude Code 2.1.x, not assumed. Most have a regression
test; breaking one tends to fail silently.

- **Budget is reserved before the peer runs, not recorded after.** An MCP server handles calls
  concurrently. If the count only incremented on completion, parallel tool calls in one turn
  would all pass the same check and blow straight through `maxPerSession`. `reserve()` /
  `settle()` / `release()` exist for exactly this.
- **`codex exec resume` accepts neither `-C` nor `-s`.** Verified: it errors with "unexpected
  argument '-s' found". The sandbox has to be restated as `-c sandbox_mode=…` and the working
  directory can only come from the spawned process's cwd. Get it wrong and a consult the caller
  asked to be read-only runs unsandboxed — a security regression that produces no error, which
  is why `claudex doctor` re-checks that `sandbox_mode` is still a real key.
- **Prompts go over stdin, never argv.** Linux caps one argv entry at 128 KiB; a prompt carrying
  a diff exceeds it. Both CLIs read from stdin (`codex exec -`, `claude -p`).
- **An unparseable review verdict is `unknown`, never `approve`.** Failing open would end a
  review loop early on broken code. `--output-schema` makes the happy path structured, but the
  schema is honoured by the model, not enforced by the CLI, so the prose fallback must work.
- **A timed-out peer returns its partial output flagged (`partial: 'timeout'`), never as a clean
  answer**, and a timeout with nothing to salvage fails. Returning a half-answer unflagged would
  defeat every review gate downstream.
- **A review gets more time than a question.** `KIND_TIMEOUT_MULTIPLIER` in `src/core/config.ts`
  scales the base timeout per kind. Observed here: an `ask` finishes in under 30s while a
  three-file `review` overshoots 300s. One flat timeout either truncates every review or lets a
  wedged question hang for a quarter of an hour. Every multiplier must be positive.
- **`timeoutMs` must be positive.** It is the only thing that reclaims a wedged peer CLI, and a
  falsy value silently disables the kill timer. `parseTimeout` rejects non-positive values and
  `runCodex` throws on them.
- **An abort must reach the spawned peer, and escalate.** Without it, an Esc in the host leaves a
  codex process running and, in write mode, still editing files. Two traps here: Node sets
  `child.killed` when a signal is *sent*, not when the process dies, so escalating to SIGKILL must
  be gated on an observed `close` — and `addEventListener` never replays an abort that fired
  before registration, so `signal.aborted` has to be checked up front.
- **A verdict is only read from a complete, successful review.** Under `--output-schema` the peer's
  intermediate progress messages are schema-shaped too, so a timed-out review can leave a stray
  `{"verdict":"approve"}` in the salvaged text. Take the final message via `-o/--output-last-message`,
  and never parse a verdict when `partial` is set.
- **A run that emitted text and then failed is always marked.** Returning salvaged output bare reads
  as a finished answer; the caller then acts on a partial opinion believing the peer stood behind it.
- **Anything expensive done before a consult must sit behind a reservation, not a check.** `review()`
  runs the host verify command — a full test suite — so it reserves its slot first and passes
  `reserved: true` into `#invoke`. Two concurrent reviews that merely checked would both launch it.
- **Progress notifications go only to callers that sent a `progressToken`** — the spec forbids
  unsolicited ones.
- **A sandboxed peer's account of a test run is not evidence.** Inside Codex's sandbox (any `-s`
  mode) Node reports a spurious EPERM from every spawn even when the child runs fine; `node
  --test` spawns a process per test file, so a passing suite reports as failing. `src/core/verify.ts`
  runs the command on the host and hands the reviewer that result.
- **The server must not `process.exit()` with a reply outstanding.** stdout to a pipe is async, so
  exiting drops anything past the pipe buffer (~128 KiB) — exactly where a long peer answer sits.
  On stdin EOF the server closes and lets the event loop drain.
- **`install` records how to spawn the server, permanently.** It prefers the `claudex-mcp` bin
  shim, whose `#!/usr/bin/env node` resolves an interpreter at run time; recording
  `process.execPath` bakes in a version-scoped nvm path that breaks on the next Node upgrade,
  and surfaces only as the server failing to connect. A dev checkout has no shim on PATH and
  falls back to the explicit `node <path>` pair.
- **`skills/claudex/SKILL.md` and the plugin's version pin are both enforced by
  `test/packaging.test.ts`**, not just documented. Bumping `package.json` without
  `.claude-plugin/plugin.json` ships a plugin that npx-installs the *previous* release, which
  reads as the new code silently not taking effect.
- **The version has exactly one source: `package.json`.** `src/core/version.ts` reads it, tsup
  injects it at build time, and `test/packaging.test.ts` fails on any hardcoded `x.y.z` in `src/`.
  0.1.1 shipped introducing itself as 0.1.0 in both `--version` and the MCP handshake — the one
  place you look to confirm a host picked up new code.
- **Every log write is fail-soft by contract.** A broken log must never turn a finished peer
  answer into an error.
- **`claude --output-format stream-json` refuses to run without `--verbose`.** The streamed
  `assistant` events are also what make progress reporting and partial salvage possible; the
  final `result` event may never arrive.

## Conventions

- **No TypeScript parameter properties, and no enums.** Node runs the sources directly under
  strip-only type stripping (`node --test test/*.test.ts`), which rejects both. Use `#private`
  fields and `as const` objects. Keeping the tests runnable with no transform is deliberate.
- Comments explain *why*, and only where the reasoning is non-obvious — several encode a verified
  CLI behaviour that reads as arbitrary otherwise. Match that density; don't add narration.
- Tests are weighted toward failure directions, not happy paths: a review that fails open, a red
  suite reported as green, a budget that overshoots under concurrency. When fixing a bug, confirm
  the new test fails with the fix reverted before considering it done.
- **To test a peer failure, put a fake `codex` on `PATH`.** Several failure directions — a peer
  that emits text then exits non-zero, one that ignores SIGTERM, one that leaves a schema-shaped
  `approve` behind before timing out — cannot be reached any other way. The pattern is: write a
  short Node script named `codex` into a temp dir, `chmod 0o755`, prepend that dir to
  `process.env.PATH`, and restore `PATH` in a `finally`. See `test/failure-modes.test.ts`. These
  scripts are built inline rather than kept as fixtures, because `node --test` treats every file
  under `test/` as a test file and a fixture that blocks on stdin hangs the run.
- Tests that exercise the MCP server spawn it as a real subprocess over real pipes, because the
  bugs worth catching are in the stdio lifecycle. They must never invoke a real Codex — use
  `policy: "off"` or `codex_budget` so the suite is fast, deterministic, and free.
- Peer replies carry `PEER_FOOTER` telling the caller to evaluate the answer rather than defer to
  it. Keep that framing in anything new — an agent that defers to its peer defeats the purpose of
  asking a second one.
