"""Minimal intent result type for dialogue helpers (legacy router archived)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class IntentResult:
    intent: str = "unknown"
    confidence: float = 0.0
    entities: dict[str, Any] = field(default_factory=dict)
    needs_filler: bool = False
