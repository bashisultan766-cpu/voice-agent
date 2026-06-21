"""Stdlib audioop was removed in Python 3.13; fall back to audioop-lts."""
from __future__ import annotations

try:
    import audioop
except ModuleNotFoundError:  # pragma: no cover — Python 3.13+
    import audioop_lts as audioop  # type: ignore[no-redef]

__all__ = ["audioop"]
