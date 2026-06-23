#!/usr/bin/env python3
"""Print Eric prompt pack summary (v4.15.1). Safe — no full prompt text."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_SECRET_PATTERNS = (
    re.compile(r"sk-[a-zA-Z0-9]{20,}"),
    re.compile(r"api[_-]?key\s*[:=]", re.I),
)


def main() -> int:
    from app.agent_runtime.prompt_pack_loader import load_prompt_pack, get_prompt_pack_status

    try:
        snap = load_prompt_pack(force_reload=True)
    except Exception as exc:
        print(f"ERROR: {exc}")
        return 1

    status = get_prompt_pack_status()
    print("Eric Prompt Pack Summary")
    print("=" * 40)
    print("Prompt pack files:")
    for name in snap.files_loaded:
        print(f"  {name}: {snap.file_chars.get(name, 0)} chars")
    print(f"Total chars: {snap.prompt_chars}")
    print(f"Hash: {snap.prompt_hash}")

    combined = snap.text
    secrets = [p.pattern[:24] for p in _SECRET_PATTERNS if p.search(combined)]
    print(f"Required sections OK: {len(snap.files_loaded) >= 6}")
    print(f"No secrets found: {not secrets}")
    if secrets:
        print(f"  (masked patterns: {secrets})")
    print(f"Status: {status.get('source', 'unknown')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
