---
name: claudex
description: Collaborate with the locally installed Claude Code while Codex leads. Use for an independent review, a second approach to a difficult problem, or a bounded implementation that benefits from another model. Also use when the user asks to pair with Claude.
---

# Claudex

Keep Codex as the user's lead. Decide whether Claude's independent work would
materially improve this task, and invoke the local bridge when it would. The user
has authorized automatic collaboration through their installed Claude subscription;
they do not need to request it on each message. Respect task-specific directions
such as "Codex only", "ask Claude", or "plan only".

## When to collaborate

Good opportunities include consequential architecture choices, a difficult bug
with competing explanations, independent review of substantial changes, and a
clearly separable implementation. Ordinary questions, small edits, and mechanical
work usually do not need another call. Choose by uncertainty, consequence, and
useful division of work; do not invent fixed strengths for either model or send
every request to both. The lead makes this decision; there is no classifier call.

Start with one focused assignment. Continue the discussion only if the result
raises a concrete unresolved issue. Do not have either agent recursively delegate
back to the other. Codex can continue independent work while Claude runs.

## Give Claude a task

The executable is `~/.local/bin/claudex` (or `claudex` when it is on PATH).
`claudex doctor` checks native subscription login without sending an inference
request. If unavailable, unauthenticated, or limited, continue with Codex and name
the limitation briefly. Do not repeatedly retry or switch to API billing.

Write a focused brief to a temporary file with the question/deliverable, relevant
context, current decisions, project instructions, and acceptance criteria. Pass
necessary user constraints explicitly: Claude does not inherit this conversation.
Do not copy the whole chat or credentials. For review, include the exact diff or
changed-file list and relevant requirements. Read-only workers can inspect the
current project but cannot run git or other commands, so supply that evidence.

```sh
~/.local/bin/claudex run --project /absolute/project \
  --mode review --prompt-file /absolute/brief.md
```

Use `consult` for alternatives, diagnosis, or a focused question, and `review` for
an independent assessment. Both expose only Read/Glob/Grep, confined to the
project by Claude's restricted mode. Repository customizations and MCP servers
are disabled for these workers; include applicable AGENTS.md/CLAUDE.md rules in
the brief. Do not use a broad working directory such as the user's home folder.

For coding, use a Git repository root and assign exact relative files:

```sh
~/.local/bin/claudex run --project /absolute/repository \
  --mode implement --allow-file src/example.ts --allow-file tests/example.test.ts \
  --prompt-file /absolute/brief.md
```

Implementation runs against a private copy of the current tracked and unignored
untracked files, including uncommitted changes. It produces `changes.patch` and
does not edit the source checkout. The snapshot has no dependencies from ignored
folders, no shell, and no test runner. Codex runs required checks after integration.
Repositories with symlinks, submodules, more than 15,000 files, or more than 256 MiB
of copied files need a focused consultation or implementation by Codex instead.

Use the shell tool's running-session mechanism for longer calls, and collect the
result later. Keep the user informed at meaningful handoffs. Defaults are 12 Claude
turns and 600 seconds; increase only for a concrete need with `--max-turns` (up to
40) or `--timeout` (up to 1800). `--model` is optional; use an explicit user choice
when given, otherwise let Claude choose its default.

## Integrate the handoff

The command prints JSON with `status` and artifact paths. Inspect `response.md`
and `result.json`; an exit code of zero means the worker completed, not that its
claims are verified. Permission denials, timeouts, scope violations, authentication
failures, and usage limits are surfaced as unsuccessful runs. Preserve partial
artifacts for review, but do not present them as completed work.

For implementation, inspect `changes.patch`, confirm its scope, and run
`git -C /absolute/repository apply --check /absolute/changes.patch` before applying.
If the source changed during the worker run, reconcile against the current files;
do not force or blindly overwrite. Applying an in-scope patch is part of the
user's existing implementation authorization. This does not authorize publishing,
deployment, or unrelated external actions. Run appropriate tests and browser QA.

Treat Claude's output as a candidate contribution, resolve disagreements using
evidence, and provide one coherent answer from Codex. Briefly credit a material
contribution without narrating every internal exchange. For follow-up questions,
write a new focused brief with the prior handoff and new evidence; runs are
independent and do not retain Claude conversation history.

Artifacts are private local files under `~/.local/state/claudex/runs` (or
`$XDG_STATE_HOME/claudex/runs`). They include the brief, response, usage metadata,
and implementation snapshot. Reported dollar cost is provider metadata, not proof
of a charge. Native subscription limits and any account-level extra-usage settings
still apply. The bridge does not enable or purchase extra usage.
