#!/usr/bin/env python3
"""
Print a directory tree safely on Windows (no reliance on Unix `tree`).

Usage:
    python scripts/debug_tree.py
    python scripts/debug_tree.py backend/app/voice --max-depth 3
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def print_tree(
    root: Path,
    *,
    prefix: str = "",
    max_depth: int = 4,
    depth: int = 0,
) -> None:
    if depth > max_depth:
        return

    try:
        entries = sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError:
        print(f"{prefix}[permission denied]")
        return

    for index, entry in enumerate(entries):
        is_last = index == len(entries) - 1
        connector = "+-- " if is_last else "|-- "
        print(f"{prefix}{connector}{entry.name}{'/' if entry.is_dir() else ''}")

        if entry.is_dir():
            extension = "    " if is_last else "|   "
            print_tree(
                entry,
                prefix=prefix + extension,
                max_depth=max_depth,
                depth=depth + 1,
            )


def main() -> int:
    parser = argparse.ArgumentParser(description="Print a directory tree (Windows-safe).")
    parser.add_argument(
        "path",
        nargs="?",
        default=".",
        help="Root directory to display (default: current directory)",
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=4,
        help="Maximum depth to traverse (default: 4)",
    )
    args = parser.parse_args()

    root = Path(args.path).resolve()
    if not root.exists():
        print(f"Path not found: {root}", file=sys.stderr)
        return 1

    print(root)
    if root.is_dir():
        print_tree(root, max_depth=args.max_depth)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
