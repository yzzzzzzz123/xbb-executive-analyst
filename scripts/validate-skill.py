"""Validate the repository's Skill package contract without a local Codex install."""

import re
import sys
from pathlib import Path

import yaml


def validate_skill(directory):
    root = Path(directory)
    source = (root / "SKILL.md").read_text(encoding="utf-8-sig")
    match = re.match(r"\A---\n(.*?)\n---(?:\n|$)", source, re.DOTALL)
    if not match:
        raise ValueError("SKILL.md must start with YAML frontmatter")
    metadata = yaml.safe_load(match.group(1))
    if not isinstance(metadata, dict):
        raise ValueError("Skill frontmatter must be a mapping")
    allowed = {"name", "description", "license", "allowed-tools", "metadata"}
    if set(metadata) - allowed:
        raise ValueError("Unsupported Skill frontmatter keys")
    name = metadata.get("name")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > 64:
        raise ValueError("Skill name must be a nonempty hyphen-case identifier of at most 64 characters")
    if name != root.name:
        raise ValueError("Skill name must match its package directory")
    description = metadata.get("description")
    if not isinstance(description, str) or not description.strip() or len(description) > 1024:
        raise ValueError("Skill description must contain 1-1024 characters")
    if "<" in description or ">" in description or description.strip().startswith("[TODO:"):
        raise ValueError("Skill description contains unsupported markup or a placeholder")
    body = source[match.end():]
    if not body.strip():
        raise ValueError("Skill instructions are missing")
    fence_character = None
    fence_length = 0
    for line in body.splitlines():
        fence = re.match(r"^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$", line)
        if fence:
            marker, suffix = fence.groups()
            if fence_character is None:
                fence_character, fence_length = marker[0], len(marker)
            elif marker[0] == fence_character and len(marker) >= fence_length and not suffix.strip():
                fence_character, fence_length = None, 0
        elif fence_character is None and re.fullmatch(r"[ ]{0,3}\[TODO:[^\n]*\][ \t]*", line):
            raise ValueError("Skill instructions contain an unfinished placeholder")
    print(f"Skill package valid: {name}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/validate-skill.py <skill-directory>")
    try:
        validate_skill(sys.argv[1])
    except (OSError, ValueError, yaml.YAMLError) as error:
        raise SystemExit(f"Skill validation failed: {error}")
