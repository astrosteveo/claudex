#!/usr/bin/env python3
"""Install/uninstall the personal Claudex command and automatic Codex policy."""

import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import sys
import uuid

SOURCE = Path(__file__).resolve().parent
START = "<!-- claudex:start -->"
END = "<!-- claudex:end -->"


def policy(skill: Path) -> str:
    return f"""{START}
## Automatic collaboration with Claude

The user wants Codex to lead their work and autonomously bring in the locally
installed Claude Code when a second model would materially help. Consider this
for substantial planning, difficult debugging, independent review, and separable
implementation. Use judgment; routine questions and small changes can stay with
Codex. Respect explicit directions such as "Codex only" or "plan only".

When collaboration is useful, read `{skill / 'SKILL.md'}` and use its Claudex
bridge. The user has authorized this workflow across their projects; no repeated
permission question is needed for in-scope collaboration. Codex owns the final
decisions, integration, verification, and user communication. If Claude is
unavailable or limited, continue with Codex and briefly state the limitation.
{END}
"""


def remove_block(text: str) -> str:
    if START not in text and END not in text:
        return text
    if text.count(START) != 1 or text.count(END) != 1 or text.index(END) < text.index(START):
        raise ValueError("Malformed Claudex block in AGENTS.md; refusing to alter other instructions.")
    before, rest = text.split(START, 1)
    _, after = rest.split(END, 1)
    return before + after.removeprefix("\n\n")


def install(*, user_home: Path, codex_dir: Path, uninstall: bool = False) -> dict:
    command = user_home / ".local/bin/claudex"
    skill = codex_dir / "skills/claudex"
    agents = codex_dir / "AGENTS.md"
    targets = {command: SOURCE / "claudex.py", skill: SOURCE / "skills/claudex"}
    old = agents.read_text(encoding="utf-8") if agents.exists() else ""
    clean = remove_block(old)
    for link, target in targets.items():
        if (link.exists() or link.is_symlink()) and not (link.is_symlink() and link.resolve() == target):
            raise ValueError(f"Refusing to replace an unrelated file: {link}")
    # Keep the original prefix exactly, including an initially empty AGENTS.md.
    updated = clean if uninstall else policy(skill) + "\n" + clean
    backup = None
    if updated != old:
        codex_dir.mkdir(parents=True, exist_ok=True)
        if agents.exists():
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
            backup = agents.with_name("AGENTS.md.before-claudex-" + stamp)
            shutil.copy2(agents, backup)
        temporary = agents.with_name(".AGENTS.claudex-" + uuid.uuid4().hex)
        temporary.write_text(updated, encoding="utf-8")
        if agents.exists():
            temporary.chmod(agents.stat().st_mode & 0o777)
        temporary.replace(agents)
    for link, target in targets.items():
        if uninstall:
            link.unlink(missing_ok=True)
        elif not link.is_symlink():
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(target, target_is_directory=target.is_dir())
    return {"action": "uninstalled" if uninstall else "installed", "command": str(command),
            "skill": str(skill), "instructions": str(agents), "backup": str(backup) if backup else None}


if __name__ == "__main__":
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(install(user_home=Path.home(), codex_dir=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))), uninstall=args.uninstall), indent=2))
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
