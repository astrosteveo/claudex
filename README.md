# Claudex

Stay in Codex. Let it bring Claude into the work when another model would help.
Codex remains responsible for the conversation, decisions, integration, and tests.

Claudex combines a small local Python bridge with a Codex skill and a short global
instruction. Codex makes the routing decision in the existing conversation; there
is no extra model call just to decide which model to call.

Typical collaboration:

- Ask Claude to challenge an architectural choice before committing to it.
- Get another explanation for a stubborn bug.
- Ask for independent review of a meaningful change.
- Delegate a specific implementation, then review and test its patch.

Simple tasks can stay with Codex. You can say "Codex only" or "ask Claude" in any
message. Calls are bounded; Claude being unavailable does not prevent Codex from
continuing. Automatic selection is an instruction to Codex, not a deterministic
hook or a guarantee that every difficult task will be delegated.

## Setup

Requires Linux/macOS, Python 3.11+, Git for implementation snapshots, and a recent
Claude Code with `--restricted`, `--safe-mode`, and `--permission-prompts` support.
Built against Claude Code 2.1.266 and Codex CLI 0.153.4.

```sh
claude auth login --claudeai
python3 install.py
~/.local/bin/claudex doctor
```

The installer links `~/.local/bin/claudex` and `$CODEX_HOME/skills/claudex` to this
project, and adds a marked policy block to `$CODEX_HOME/AGENTS.md` (default
`~/.codex`). Existing instructions are preserved and backed up before changes.
Keep this project at its installed location. No MCP service or API account is
required, and `config.toml` is not changed.

Start a new Codex task/session to load the global policy. Codex normally detects
skill changes automatically; restart the app if the new skill is missing.

Only one-time Claude authentication requires your interaction. Logging into a
Claude app does not establish a Claude Code CLI login. A successful `doctor`
confirms the native subscription authentication method, not remaining quota.

## What a worker can do

| Mode | Claude's access | Handoff |
| --- | --- | --- |
| `consult` | Read/search the project | Analysis, options, diagnosis, or proposed code |
| `review` | Read/search the project | Findings and supporting evidence |
| `implement` | Read/edit an isolated copy | Report plus a patch limited to assigned files |

Claude workers have no shell, network tools, nested agents, or MCP connectors.
Restricted mode confines file tools to their working directory. Safe mode removes
repository/user customizations; applicable instructions and relevant context must
be supplied in the task brief. Managed Claude policies still apply.

Implementation snapshots contain the current tracked and unignored untracked
files, including staged and unstaged edits. Ignored dependency folders are not
copied. Snapshot Git ignores inherited repository/index overrides and neutralizes
file conversion attributes, so patches describe the actual working-file bytes.
The source checkout and index remain untouched. Repositories with
symlinks/submodules or snapshots beyond 15,000 files/256 MiB use consultation
instead. This is a deliberate initial scope limit.

Codex checks the patch, applies it to the current project, and runs the relevant
tests and browser checks. Claude's report is evidence to evaluate, not proof that
the result is correct.

## Commands and artifacts

Codex normally handles these commands for you:

```sh
claudex run --project /path/to/repository --mode review --prompt-file /tmp/brief.md
claudex run --project /path/to/repository --mode implement \
  --allow-file src/example.py --prompt-file /tmp/brief.md
```

`--prompt-file -` reads stdin. Optional `--model`, `--max-turns` (default 12), and
`--timeout` (default 600 seconds) allow focused adjustments. No automatic retries
or fallback to paid API authentication are performed. Each run is independent;
follow-up briefs should include the relevant prior handoff.

Run artifacts live in `$XDG_STATE_HOME/claudex/runs`, defaulting to
`~/.local/state/claudex/runs`. Each private directory contains the task brief,
Claude response, JSON status/usage, logs, and for implementation a workspace and
`changes.patch`. These may contain project code. Retain them for review and remove
old run directories when no longer needed; there is no background cleanup daemon.

Statuses distinguish completion, missing authentication, usage limits, timeouts,
denied permissions, failed runs, and out-of-scope changes. A worker never applies
its patch to the source automatically.

## Subscription behavior

Claudex invokes the installed `claude --print` using its own subscription login.
It removes API/provider overrides from the worker environment and rejects
Console/API authentication. It does not extract, store, or proxy OAuth tokens.

As checked on September 8, 2026, Anthropic's updated support notice says that the
announced separation of Agent SDK/`claude -p` usage was paused and these calls still
draw from subscription usage limits. The old announcement remains on some docs.
Account-level extra usage settings still apply; Claudex does not enable, purchase,
or manage them. Reported `total_cost_usd` is provider metadata, not proof of a bill.
See the [updated subscription usage notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
and [API-key precedence guidance](https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code).

## Verify or remove

```sh
python3 -m unittest discover -s tests -v
python3 install.py --uninstall
```

The tests use a fake Claude process and real temporary Git repositories. They
exercise authentication gates, failure handling, timeout termination, literal
prompt delivery, dirty-worktree snapshots, patch integration, and installation.
Native consultation and implementation runs have also been verified with the
signed-in subscription. See [VALIDATION.md](VALIDATION.md) for the evidence and
review corrections.
Uninstall removes only Claudex's links and marked instruction block; artifacts
and backups remain available.

Integration references: [Codex skills](https://developers.openai.com/codex/skills/),
[Claude programmatic mode](https://code.claude.com/docs/en/headless), and
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference).
