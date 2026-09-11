---
name: claudex
description: Collaborate with the locally installed Codex CLI while Claude Code leads. Use for an independent review, a second approach to a difficult problem, or a bounded implementation that benefits from another model. Always use it when the task needs a generated raster image (texture, sprite, photo, illustration, mockup, transparent cutout) because Codex has $imagegen and Claude Code cannot generate images. Also use when the user asks to pair with Codex.
---

# Claudex

Keep Claude Code as the user's lead. Decide whether Codex's independent work would
materially improve this task, and invoke the local bridge when it would. The user
has authorized automatic collaboration through their installed ChatGPT login for
Codex; they do not need to request it on each message. Respect task-specific
directions such as "Claude only", "ask Codex", or "plan only".

## When to collaborate

Good opportunities include consequential architecture choices, a difficult bug
with competing explanations, independent review of substantial changes, and a
clearly separable implementation. Ordinary questions, small edits, and mechanical
work usually do not need another call. Choose by uncertainty, consequence, and
useful division of work; do not invent fixed strengths for either model or send
every request to both. The lead makes this decision; there is no classifier call.

Start with one focused assignment. Continue the discussion only if the result
raises a concrete unresolved issue. Do not have either agent recursively delegate
back to the other, and do not wrap the bridge in a subagent. Claude Code can
continue independent work while Codex runs.

## Invariant: generated images come from Codex

Claude Code cannot generate images; Codex can, through its `$imagegen` system
skill and built-in `image_gen` tool. Whenever the task needs a generated raster
asset (textures, sprites, tiles, photos, illustrations, hero images, product or UI
mockups, transparent cutouts, edits of an existing bitmap), always bring Codex in
for that part, regardless of how small the rest of the task is. Repo-native SVG,
CSS, or canvas work stays with Claude.

- For a project asset, use `--mode implement` and assign the exact output path,
  e.g. `--allow-file assets/textures/stone.png`; the image arrives in
  `changes.patch` as a binary diff. Assign a sibling versioned name rather than an
  existing asset unless the user asked for replacement.
- For a preview or concept, use `--mode consult`; the image stays under
  `$CODEX_HOME/generated_images/` and Codex reports its absolute path, which
  Claude Code can copy where the user wants it.
- In the brief, name the skill (`Use $imagegen with the built-in image_gen tool`),
  give the subject, style, size or aspect ratio, exact text if any, and
  constraints. The bridge passes no `OPENAI_API_KEY`, so ask for the built-in
  tool rather than the skill's CLI fallback.
- Inspect the returned image before presenting it, and let the user judge fit.

## Give Codex a task

The executable is `~/.local/bin/claudex` (or `claudex` when it is on PATH).
`claudex doctor --worker codex` checks the native ChatGPT login without sending an
inference request; run it before the first call in a session. If Codex is
unavailable, unauthenticated, or limited, continue as Claude and name the
limitation briefly. Do not repeatedly retry or switch to API billing.

Write a focused brief to a temporary file with the question/deliverable, relevant
context, current decisions, project instructions, and acceptance criteria. Pass
necessary user constraints explicitly: Codex does not inherit this conversation.
Do not copy the whole chat or credentials. For review, include the exact diff or
changed-file list and relevant requirements. Codex has a shell, so it can run
`git log`, `git diff`, and `grep` itself; you need not paste that output, but do
name the commits or files that matter.

```sh
~/.local/bin/claudex run --worker codex --project /absolute/project \
  --mode review --prompt-file /absolute/brief.md
```

Use `consult` for alternatives, diagnosis, or a focused question, and `review` for
an independent assessment. Codex runs with the user's own Codex configuration:
their model and reasoning effort, approval policy, sandbox mode, MCP servers,
plugins, hooks, and the project's AGENTS.md apply exactly as in an interactive
Codex session. Read-only modes ask Codex not to edit files; the bridge adds no
sandbox of its own, so do not point a worker at a folder you would not open
interactive Codex in, and do not use a broad working directory such as the user's
home folder. Rules Codex would not see on its own, such as CLAUDE.md, go in the
brief.

For coding, use a Git repository root and assign exact relative files:

```sh
~/.local/bin/claudex run --worker codex --project /absolute/repository \
  --mode implement --allow-file src/example.ts --allow-file tests/example.test.ts \
  --prompt-file /absolute/brief.md
```

Implementation runs against a private copy of the current tracked and unignored
untracked files, including uncommitted changes. It produces `changes.patch` and
does not edit the source checkout. The snapshot omits ignored dependency folders;
Codex may install what it needs there and run checks, but Claude Code runs the
authoritative checks after integration. Repositories with symlinks,
submodules, more than 15,000 files, or more than 256 MiB of copied files need a
focused consultation or implementation by Claude instead.

Use the Bash tool's `run_in_background` option for longer calls and collect the
result when notified. Keep the user informed at meaningful handoffs. The default
timeout is 600 seconds; increase only for a concrete need with `--timeout` (up to
1800). `--max-turns` does not apply to Codex. `--model` is optional; use an
explicit user choice when given, otherwise let Codex choose its default.

## Integrate the handoff

The command prints JSON with `status` and artifact paths. Inspect `response.md`
and `result.json`; an exit code of zero means the worker completed, not that its
claims are verified. Rejected commands, timeouts, scope violations, authentication
failures, and usage limits are surfaced as unsuccessful runs. Preserve partial
artifacts for review, but do not present them as completed work.

Consult and review run in the real checkout, so the result also carries
`source_changes`: files that changed in the project during the run, with a
`warning` when the list is not empty. Anything on that list you did not edit
yourself was edited by Codex despite the read-only instruction; inspect it with
`git diff`/`git status` and revert what was not asked for before continuing.

For implementation, inspect `changes.patch`, confirm its scope, and run
`git -C /absolute/repository apply --check /absolute/changes.patch` before applying.
If the source changed during the worker run, reconcile against the current files;
do not force or blindly overwrite. Applying an in-scope patch is part of the
user's existing implementation authorization. This does not authorize publishing,
deployment, or unrelated external actions. Run appropriate tests and browser QA.

Treat Codex's output as a candidate contribution, resolve disagreements using
evidence, and provide one coherent answer from Claude. Briefly credit a material
contribution without narrating every internal exchange. For follow-up questions,
write a new focused brief with the prior handoff and new evidence; runs are
independent and do not retain Codex conversation history.

Artifacts are private local files under `~/.local/state/claudex/runs` (or
`$XDG_STATE_HOME/claudex/runs`). They include the brief, response, JSONL event
log, usage metadata, and implementation snapshot. Native ChatGPT plan limits
still apply. The bridge does not enable or purchase extra usage.
