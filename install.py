#!/usr/bin/env python3
"""Install/uninstall the personal Claudex command, skills, and automatic policies."""

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
# Each lead is the CLI the user drives; the skill and policy teach it to bring in
# the other CLI as a worker. Both leads may be installed side by side.
LEADS = {
    "codex": {
        "lead": "Codex", "short": "Codex", "worker": "Claude Code", "worker_short": "Claude",
        "skill_source": "skills/codex-lead/claudex", "instructions": "AGENTS.md",
        "env": "CODEX_HOME", "default_dir": ".codex", "invariant": "",
    },
    "claude": {
        "lead": "Claude Code", "short": "Claude", "worker": "Codex CLI", "worker_short": "Codex",
        "skill_source": "skills/claude-lead/claudex", "instructions": "CLAUDE.md",
        "env": "CLAUDE_CONFIG_DIR", "default_dir": ".claude",
        "invariant": """ Always use it when the task needs generated raster images such as
textures, sprites, photos, illustrations, or mockups: Codex generates images through
its `$imagegen` skill and Claude Code cannot.""",
    },
}


def policy(lead: str, skill: Path) -> str:
    spec = LEADS[lead]
    return f"""{START}
## Automatic collaboration with {spec['worker_short']}

The user wants {spec['lead']} to lead their work and autonomously bring in the locally
installed {spec['worker']} when a second model would materially help. Consider this
for substantial planning, difficult debugging, independent review, and separable
implementation. Use judgment; routine questions and small changes can stay with
{spec['short']}.{spec['invariant']} Respect explicit directions such as "{spec['short']} only" or "plan only".

When collaboration is useful, read `{skill / 'SKILL.md'}` and use its Claudex
bridge. The user has authorized this workflow across their projects; no repeated
permission question is needed for in-scope collaboration. {spec['lead']} owns the final
decisions, integration, verification, and user communication. If {spec['worker_short']} is
unavailable or limited, continue with {spec['short']} and briefly state the limitation.
{END}
"""


def remove_block(text: str) -> str:
    if START not in text and END not in text:
        return text
    if text.count(START) != 1 or text.count(END) != 1 or text.index(END) < text.index(START):
        raise ValueError("Malformed Claudex block; refusing to alter other instructions.")
    before, rest = text.split(START, 1)
    _, after = rest.split(END, 1)
    return before + after.removeprefix("\n\n")


def replace_instructions(path: Path, old: str, updated: str) -> Path | None:
    """Write the instruction file atomically, keeping a backup of any prior content."""
    if updated == old:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if path.exists():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
        backup = path.with_name(path.name + ".before-claudex-" + stamp)
        shutil.copy2(path, backup)
    temporary = path.with_name("." + path.name + ".claudex-" + uuid.uuid4().hex)
    temporary.write_text(updated, encoding="utf-8")
    if path.exists():
        temporary.chmod(path.stat().st_mode & 0o777)
    temporary.replace(path)
    return backup


def owned(link: Path, target: Path) -> bool:
    """A symlink Claudex created earlier, possibly to a path this version moved."""
    if not link.is_symlink():
        return False
    return link.resolve() == target or (link.parent / link.readlink()).resolve().is_relative_to(SOURCE)


def relink(link: Path, target: Path) -> None:
    if link.is_symlink() and link.resolve() != target:
        link.unlink()
    if not link.is_symlink():
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(target, target_is_directory=target.is_dir())


def install(*, user_home: Path, codex_dir: Path | None = None, claude_dir: Path | None = None,
            leads: tuple[str, ...] = tuple(LEADS), uninstall: bool = False) -> dict:
    dirs = {"codex": codex_dir or user_home / ".codex", "claude": claude_dir or user_home / ".claude"}
    command = user_home / ".local/bin/claudex"
    links = {command: SOURCE / "claudex.py"}
    documents = {}
    # Validate every target before changing anything, so a refusal leaves no partial install.
    for lead in leads:
        spec = LEADS[lead]
        skill = dirs[lead] / "skills/claudex"
        links[skill] = SOURCE / spec["skill_source"]
        instructions = dirs[lead] / spec["instructions"]
        old = instructions.read_text(encoding="utf-8") if instructions.exists() else ""
        clean = remove_block(old)
        # Keep the original prefix exactly, including an initially empty file.
        documents[lead] = (instructions, old, clean if uninstall else policy(lead, skill) + "\n" + clean)
    for link, target in links.items():
        if (link.exists() or link.is_symlink()) and not owned(link, target):
            raise ValueError(f"Refusing to replace an unrelated file: {link}")
    result = {"action": "uninstalled" if uninstall else "installed", "leads": list(leads), "command": str(command)}
    for lead in leads:
        instructions, old, updated = documents[lead]
        backup = replace_instructions(instructions, old, updated)
        skill = dirs[lead] / "skills/claudex"
        if uninstall:
            skill.unlink(missing_ok=True)
        else:
            relink(skill, links[skill])
        result[lead] = {"skill": str(skill), "instructions": str(instructions), "backup": str(backup) if backup else None}
    remaining = [lead for lead in LEADS if lead not in leads and (dirs[lead] / "skills/claudex").is_symlink()]
    if uninstall and not remaining:
        command.unlink(missing_ok=True)
    elif not uninstall:
        relink(command, links[command])
    return result


if __name__ == "__main__":
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lead", choices=("codex", "claude", "both"), default="both",
                        help="Which interactive CLI to set up as the lead (default: both)")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()
    home = Path.home()
    selected = tuple(LEADS) if args.lead == "both" else (args.lead,)
    try:
        print(json.dumps(install(
            user_home=home,
            codex_dir=Path(os.environ.get("CODEX_HOME", str(home / ".codex"))).expanduser(),
            claude_dir=Path(os.environ.get("CLAUDE_CONFIG_DIR", str(home / ".claude"))).expanduser(),
            leads=selected, uninstall=args.uninstall,
        ), indent=2))
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
