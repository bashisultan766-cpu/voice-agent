"""Eric dialogue brain package (v4.9)."""
from __future__ import annotations

from .eric_dialogue_brain import (
    EricDialogueBrain,
    apply_brain_to_intent,
    get_brain_response_text,
    get_dialogue_brain,
)
from .eric_policy import build_brain_policy_summary, build_composer_policy, get_policy
from .schema import BrainDecision, parse_brain_json

__all__ = [
    "BrainDecision",
    "EricDialogueBrain",
    "apply_brain_to_intent",
    "build_brain_policy_summary",
    "build_composer_policy",
    "get_brain_response_text",
    "get_dialogue_brain",
    "get_policy",
    "parse_brain_json",
]
