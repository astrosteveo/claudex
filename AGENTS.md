# Claudex development

Claudex is a personal local bridge from Codex to the user's installed Claude Code.
Keep Codex as the lead and use Claude's native subscription login. Do not add API
key fallback or extract OAuth credentials. Prefer standard-library Python.

`claudex.py` owns worker execution and artifacts. `install.py` installs the command,
skill, and a marked global instruction block while preserving existing settings.
`skills/claudex/SKILL.md` defines when and how Codex collaborates.

Validate with `python3 -m unittest discover -s tests -v` and `./claudex.py doctor`.
Tests use a fake Claude process and temporary repositories; report real inference
tests separately. Implementation workers must leave the source checkout unchanged,
preserve its uncommitted state in their snapshot, and return a reviewable patch.
