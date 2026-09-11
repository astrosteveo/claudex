# Claudex development

Claudex is a personal local bridge between the user's installed Claude Code and
Codex. The lead is whichever CLI the user drives; the other is the headless worker.
Use each worker's native subscription login (Claude subscription, ChatGPT login for
Codex). Do not add API key fallback or extract OAuth credentials for either provider.
Prefer standard-library Python.

`claudex.py` owns worker execution and artifacts for both workers. `install.py`
installs the command, one skill per lead, and a marked global instruction block per
lead while preserving existing settings. `skills/codex-lead/claudex/SKILL.md`
defines how Codex collaborates with Claude; `skills/claude-lead/claudex/SKILL.md`
defines how Claude Code collaborates with Codex, including the invariant that
generated raster images come from Codex's `$imagegen`.

Validate with `python3 -m unittest discover -s tests -v`, `./claudex.py doctor`, and
`./claudex.py doctor --worker codex`. Tests use fake Claude and Codex processes and
temporary repositories; report real inference tests separately. Implementation
workers must leave the source checkout unchanged, preserve its uncommitted state in
their snapshot, and return a reviewable patch. Every worker environment carries
`CLAUDEX_WORKER=1` and `claudex run` must keep refusing to start under it.
