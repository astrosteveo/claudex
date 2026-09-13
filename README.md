# Claudex

Drive the coding CLI you prefer. Let it bring the other one into the work when a
second model would help. The CLI you drive stays responsible for the conversation,
decisions, integration, and tests; the other runs headless on a focused task.

| You drive | Worker | Skill | Policy | Command |
| --- | --- | --- | --- | --- |
| Codex | Claude Code (`claude --print`) | `$claudex` from `$CODEX_HOME/skills/claudex` | block in `$CODEX_HOME/AGENTS.md` | `claudex run ...` |
| Claude Code | Codex (`codex exec`) | `/claudex` from `~/.claude/skills/claudex` | block in `~/.claude/CLAUDE.md` | `claudex run --worker codex ...` |

Claudex combines a small local Python bridge with one skill per lead and a short
global instruction. The lead makes the routing decision in the existing
conversation; there is no extra model call just to decide which model to call.
Both leads can be installed side by side; whichever CLI you open is the lead.

Typical collaboration:

- Ask the other model to challenge an architectural choice before committing to it.
- Get another explanation for a stubborn bug.
- Ask for independent review of a meaningful change.
- Delegate a specific implementation, then review and test its patch.
- From Claude Code, generate raster images: Codex has the `$imagegen` skill and
  Claude Code has no image generation, so the Claude-lead skill treats textures,
  sprites, photos, illustrations, and mockups as an invariant handoff to Codex.

Simple tasks stay with the lead. You can say "Codex only", "Claude only", "ask
Claude", or "ask Codex" in any message. Tasks stay focused; a worker being
unavailable does not prevent the lead from continuing. Automatic selection is an
instruction to the lead, not a deterministic hook or a guarantee.

## Setup

Requires Linux/macOS, Python 3.11+, Git for implementation snapshots, and recent
CLIs: Claude Code with `--restricted`, `--safe-mode`, and `--permission-prompts`;
Codex with `exec --json`, `--output-last-message`, and `--ephemeral`. A Codex
worker needs a non-interactive approval policy in your `config.toml`
(`approval_policy = "never"`) or it will have nothing to answer approval prompts.
Built against Claude Code 2.1.268 and Codex CLI 0.154.0.

```sh
claude auth login --claudeai   # Claude as worker
codex login                    # Codex as worker
python3 install.py             # or --lead codex / --lead claude
~/.local/bin/claudex doctor
~/.local/bin/claudex doctor --worker codex
```

The installer links `~/.local/bin/claudex` to this project and, per selected lead,
links the skill directory and adds a marked policy block to the lead's global
instruction file (`$CODEX_HOME/AGENTS.md`, default `~/.codex`; `~/.claude/CLAUDE.md`
or `$CLAUDE_CONFIG_DIR`). Existing instructions are preserved and backed up before
changes. Keep this project at its installed location. No MCP service or API account
is required, and neither CLI's own configuration file is changed.

Start a new session in the lead to load the global policy. Both CLIs normally
detect skill changes automatically; restart the app if the new skill is missing.

Only one-time authentication requires your interaction. A successful `doctor`
confirms the native subscription login method, not remaining quota.

## What a worker can do

| Mode | Claude worker | Codex worker | Handoff |
| --- | --- | --- | --- |
| `consult` | Read/search the project | Your Codex, asked not to edit | Analysis, options, diagnosis, or proposed code |
| `review` | Read/search the project | Your Codex, asked not to edit | Findings and supporting evidence |
| `implement` | Read/edit an isolated copy | Your Codex in an isolated copy | Report plus a patch limited to assigned files |

Claude workers have no shell, network tools, nested agents, or MCP connectors.
Restricted mode confines file tools to their working directory. Safe mode removes
repository/user customizations; applicable instructions and relevant context must
be supplied in the task brief. Managed Claude policies still apply.

Codex workers are your Codex. `codex exec` loads your `config.toml` unchanged, so
your model and reasoning effort, approval policy, sandbox mode, MCP servers,
plugins, hooks, execpolicy rules, memories, and the project's AGENTS.md apply
exactly as in an interactive Codex session. The bridge adds only plumbing (an
ephemeral session, `-C` pointing at the project or snapshot, JSONL output, the role
instruction as `developer_instructions`) and two recursion guards: it hides its
own `claudex` skill from the worker by path, and every worker environment carries
`CLAUDEX_WORKER=1`, which makes `claudex run` refuse to start, so a worker cannot
start another worker. The global `$CODEX_HOME/AGENTS.md`, which contains the
Codex-lead policy when both leads are installed, is still loaded; the role
instruction tells the worker to ignore requests to bring in Claude.

Because the bridge imposes no sandbox of its own, a consult/review worker running
under a permissive configuration such as `sandbox_mode = "danger-full-access"` is
kept read-only by instruction alone, and an implement worker's shell is not
confined to the snapshot even though the patch is scope-checked. Point Codex
workers only at folders you would open interactive Codex in. As a backstop,
read-only runs in a Git project record the size and mtime of every tracked and
unignored file before and after the worker; any difference is listed in
`source_changes` with a `warning` in the result. The run is not failed, because
the lead may legitimately keep editing while the worker runs, but the lead is told
to treat files it did not touch itself as worker edits to inspect and revert.

The Codex worker has the `$imagegen` system skill and its built-in `image_gen`
tool, which runs through Codex's own ChatGPT connection. Generated images land
under `$CODEX_HOME/generated_images/`; in `implement` mode the worker copies the
selected image into an assigned path and it arrives in `changes.patch` as a binary
diff. The bridge passes no `OPENAI_API_KEY`, so the skill's CLI fallback is not
available to the worker.

Implementation snapshots contain the current tracked and unignored untracked
files, including staged and unstaged edits. Ignored dependency folders are not
copied. Snapshot Git ignores inherited repository/index overrides and neutralizes
file conversion attributes, so patches describe the actual working-file bytes.
The source checkout and index remain untouched. Repositories with
symlinks/submodules or snapshots beyond 15,000 files/256 MiB use consultation
instead. This is a deliberate initial scope limit.

The lead checks the patch, applies it to the current project, and runs the relevant
tests and browser checks. A worker's report is evidence to evaluate, not proof that
the result is correct.

## Commands and artifacts

The lead normally handles these commands for you:

```sh
claudex run --project /path/to/repository --mode review --prompt-file /tmp/brief.md
claudex run --worker codex --project /path/to/repository --mode implement \
  --allow-file src/example.py --allow-file assets/texture.png --prompt-file /tmp/brief.md
```

`--worker` defaults to `claude`. `--prompt-file -` reads stdin. `--model` is
optional. Worker runs have **no timeout or turn cap by default**. Only when the
user requests a limit, pass `--timeout SECONDS` for either worker or
`--max-turns TURNS` for Claude. Both accept positive integers with no
bridge-imposed upper bound. Omit a limit to leave it unlimited; result metadata records omitted
`timeout_seconds` and `max_turns` as `null`. CLI health checks and local Git
operations retain their diagnostic timeouts.

Agents should use running sessions or background execution, collect the same run
until completion or user cancellation, and keep the user informed. Short yield or
polling intervals must not become execution deadlines; do not add shell or tool
timeouts unless the user requests them. Ctrl-C and termination still cancel the
worker process group. No automatic retries or fallback to API authentication are
performed. Each run is independent; follow-up briefs should include the relevant
prior handoff.

Run artifacts live in `$XDG_STATE_HOME/claudex/runs`, defaulting to
`~/.local/state/claudex/runs`. Each private directory contains the task brief,
the worker's response, JSON status/usage, logs (`stdout.json` for Claude,
`stdout.jsonl` and `last-message.md` for Codex), and for implementation a
workspace and `changes.patch`. These may contain project code. Retain them for
review and remove old run directories when no longer needed; there is no
background cleanup daemon.

Statuses distinguish completion, missing authentication, usage limits, timeouts,
denied permissions (Claude tool denials; Codex commands declined by its approval
policy), failed runs, and out-of-scope changes. A worker never
applies its patch to the source automatically.

## Subscription behavior

Claudex invokes the installed `claude --print` with its own subscription login and
the installed `codex exec` with its own ChatGPT login. It removes API/provider
overrides (`ANTHROPIC_*`, `CLAUDE_*` SDK settings, `OPENAI_*`, `CODEX_API_KEY`)
from the worker environment and treats API-key authentication as not signed in.
It does not extract, store, or proxy OAuth tokens or `auth.json`.

As checked on September 8, 2026, Anthropic's updated support notice says that the
announced separation of Agent SDK/`claude -p` usage was paused and these calls still
draw from subscription usage limits. The old announcement remains on some docs.
Account-level extra usage settings still apply; Claudex does not enable, purchase,
or manage them. Reported `total_cost_usd` is provider metadata, not proof of a bill.
See the [updated subscription usage notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
and [API-key precedence guidance](https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code).
Codex worker runs and image generation draw from the ChatGPT plan's Codex limits;
`codex exec` reports token usage but no cost figure.

## Verify or remove

```sh
python3 -m unittest discover -s tests -v
python3 install.py --uninstall            # or --uninstall --lead claude
```

The tests use fake Claude and Codex processes and real temporary Git repositories.
They exercise authentication gates, environment scrubbing, the nested-run guard,
failure handling, unlimited defaults, explicit limits, timeout termination,
literal prompt delivery, dirty-worktree snapshots, patch integration, and
installation of either or both leads. Native consultation, review, implementation,
and image-generation runs have also been
verified with the signed-in subscriptions. See [VALIDATION.md](VALIDATION.md) for
the evidence and review corrections.
Uninstall removes only Claudex's links and marked instruction blocks; artifacts
and backups remain available.

Integration references: [Codex skills](https://developers.openai.com/codex/skills/),
[Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/),
[Claude Code skills](https://code.claude.com/docs/en/skills),
[Claude programmatic mode](https://code.claude.com/docs/en/headless), and
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference).
