# claudex

Gives **Claude Code** a second opinion from **Codex** — and gives you a dial for how often it asks.

If you pay for both Claude and ChatGPT, you already own two coding agents that were trained
differently and fail differently. The problem is that they don't talk, and the obvious fix —
wiring them together and letting one call the other whenever it feels like it — quietly spends
the second subscription.

claudex wires them together **and** puts a budget in front of the wire.

The point is not that one model is better. It is that **the agent reviewing the code is not the
agent that wrote it**, so it has no sunk cost in the approach it is checking.

---

## Requirements

- An active **Claude** subscription, logged in via `claude`
- An active **ChatGPT** subscription, logged in via `codex login`
- Node 20.11+

`claudex doctor` checks all of it, including whether Codex is authenticated against a
subscription or an API key — the latter still works, but bills per token.

---

## Install

```bash
npm install -g @astrosteveo/claudex
claudex doctor      # verify both CLIs are installed, authed, and behaving as claudex assumes
claudex install     # register the MCP server with Claude Code, and write the guidance skill
```

Restart any running Claude Code session afterwards.

Or as a Claude Code plugin, which bundles the server and the skill together:

```
/plugin marketplace add <this-repo>
/plugin install claudex
```

---

## What Claude gains

Six tools. All of them default to **read-only** — Codex can inspect the repository but not
change it — and every one of them passes through the budget first.

| Tool | What it does |
|---|---|
| `ask_codex` | One narrow question. Codex reads the repo itself; you don't paste code at it. |
| `codex_review` | Adversarial review, defaulting to the uncommitted changes. Returns a verdict. |
| `codex_reply` | Continue a thread by id. Cheap, and pushing back is the intended use. |
| `codex_delegate` | Hand Codex a scoped implementation task. **Writes to the working tree.** |
| `codex_debate` | Two rounds: Codex answers independently, then attacks your answer. |
| `codex_budget` | Free. How much consultation is left this session. |

Every answer comes back with a footer telling Claude to treat it as an argument to evaluate,
not a verdict to comply with. An agent that defers to its peer has bought nothing.

```
You → claude
  Claude: [reads the code, writes a fix]
  Claude → ask_codex("Is this retry loop safe under concurrent failures?")
       Codex: [independently reads the repo] → "No — two writers can both pass
              the check at queue.js:41 before either increments."
  Claude: [fixes the race it would not have caught reviewing its own work]
```

---

## The dial

This is the part that isn't just "two agents in a trenchcoat."

```bash
claudex policy set on-request    # default: Claude asks when it judges it worthwhile
claudex policy set assisted      # + automatic review before commits, after repeated failures
claudex policy set aggressive    # + any non-trivial design decision
claudex policy set off           # installed but dormant
```

Each policy carries a budget, and the budget is **enforced in the server**, not suggested in a
prompt:

| Policy | Consults/session | Tokens/session | Cooldown |
|---|---|---|---|
| `off` | 0 | 0 | — |
| `on-request` | 12 | 400k | none |
| `assisted` | 25 | 900k | 10s |
| `aggressive` | 60 | unlimited | none |

Tune any of it:

```bash
claudex policy budget --max-per-session 5 --max-tokens 200000
claudex policy budget --cooldown-ms 30000 --global    # user-level instead of project-level
```

When the budget runs out, the tool doesn't error — it returns a **structured refusal** that
explains what was spent and tells Claude not to retry. A language model can plan around that;
it just retries an exception.

Config layers lowest to highest: policy defaults → `~/.claudex/config.json` →
`<project>/.claudex/config.json` → environment (`CLAUDEX_POLICY`, `CLAUDEX_MODE`,
`CLAUDEX_MAX_PER_SESSION`, `CLAUDEX_TIMEOUT_MS`, `CLAUDEX_MODEL`). Project beats user so a repo
can tighten spend for everyone in it; environment beats both so one run can be steered without
editing anything.

See what it actually cost:

```bash
claudex status      # consults, denials, failures, peer wall-clock, recent activity
claudex log -n 100  # raw records as JSONL
```

---

## Giving reviewers real evidence

```bash
claudex policy verify "npm test"
```

With this set, `codex_review` runs your test suite **on the host** and hands Codex the result.

This is not a convenience. Inside Codex's sandbox, Node reports a spurious `EPERM` from every
child spawn even when the child runs fine — and `node --test` spawns a process per test file, so
a fully passing suite reports itself as failing. **A sandboxed peer's account of a test run is
not evidence.** claudex runs the command itself and hands over the real result.

---

## From the shell

The same machinery, without going through Claude Code:

```bash
claudex ask "does the cache in src/store.ts invalidate on write?"
claudex review                          # uncommitted changes
claudex review "the last 3 commits"

claudex solve "add retry with backoff to the upload path" --apply
claudex debate "should the queue be at-least-once or exactly-once here?"
```

`solve` runs **plan → implement → verify → review → fix**: Claude plans and reviews, Codex
implements, your test suite runs on the host between the two, and it loops until the reviewer
approves or the round budget runs out.

`debate` has both agents answer **independently** — neither sees the other's answer first, so
agreement afterwards is evidence rather than an artifact of one anchoring the other — then
critique each other.

Both write a full transcript to `.claudex/runs/<n>-<kind>/`.

---

## Design notes

**One direction, on purpose.** Codex is a service here, not a peer with a session of its own.
Wiring the reverse would only pay off if a spawned `codex exec` called back into Claude — cold
context, a recursion hazard, and real cost for near-zero gain. The agent adapters are symmetric
internally, so adding it later is an addition, not a rewrite.

**Built on `codex exec`.** Codex also ships `codex mcp-server`, which would hand us thread
management for free — but it prints a deprecation warning and is slated for removal, and its
successor `codex app-server` is still experimental with a generated protocol. For a package
other people install, `exec` is the interface that will still be there next month.

**Bundled to single files.** The server is launched by an agent CLI, often inside a sandbox,
where a transitive dependency that fails to resolve takes the whole integration down with no
useful error. `dist/` has no runtime resolution surprises.

---

## License

MIT
