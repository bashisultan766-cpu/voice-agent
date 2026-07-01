"""
Long-term emotional drift — baseline personality stored on SessionState.

Gradual baseline shifts from repeated success, failure, and interrupts.
Effective emotion = 70% current turn state + 30% baseline (smoothed).
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import SessionState

_BASELINE_DRIFT = 0.035
_BASELINE_SMOOTH = 0.25
_CURRENT_WEIGHT = 0.7
_BASELINE_WEIGHT = 0.3


def default_emotional_memory() -> dict[str, float]:
    return {
        "baseline_valence": 0.0,
        "baseline_arousal": 0.3,
    }


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def ensure_emotional_memory(session: "SessionState | None") -> dict[str, float]:
    if session is None:
        return default_emotional_memory()
    memory = getattr(session, "emotional_memory", None)
    if not isinstance(memory, dict) or not memory:
        session.emotional_memory = default_emotional_memory()
        return session.emotional_memory
    for key, default in default_emotional_memory().items():
        memory.setdefault(key, default)
    return memory


def _nudge_baseline(memory: dict[str, float], key: str, delta: float, lo: float, hi: float) -> None:
    target = _clamp(memory[key] + delta, lo, hi)
    memory[key] = _clamp(
        memory[key] + _BASELINE_SMOOTH * (target - memory[key]),
        lo,
        hi,
    )


def record_emotion_turn(
    session: "SessionState | None",
    *,
    had_success: bool = False,
    had_failure: bool = False,
) -> None:
    """Slowly drift baseline personality from repeated success or failure."""
    if session is None:
        return
    memory = ensure_emotional_memory(session)
    if had_success:
        _nudge_baseline(memory, "baseline_valence", _BASELINE_DRIFT, -1.0, 1.0)
    if had_failure:
        _nudge_baseline(memory, "baseline_valence", -_BASELINE_DRIFT, -1.0, 1.0)


def note_interrupt_memory(session: "SessionState | None") -> None:
    """Repeated interrupts raise baseline arousal gradually."""
    if session is None:
        return
    memory = ensure_emotional_memory(session)
    _nudge_baseline(memory, "baseline_arousal", _BASELINE_DRIFT, 0.0, 1.0)


def effective_emotion_field(
    emotion_field: dict[str, float],
    emotional_memory: dict[str, float] | None,
) -> dict[str, float]:
    """
    Blend instantaneous emotion with long-term baseline.

    current = 70% turn state + 30% baseline (valence & arousal).
    """
    memory = emotional_memory or default_emotional_memory()
    return {
        "valence": _clamp(
            _CURRENT_WEIGHT * float(emotion_field.get("valence", 0.0))
            + _BASELINE_WEIGHT * float(memory.get("baseline_valence", 0.0)),
            -1.0,
            1.0,
        ),
        "arousal": _clamp(
            _CURRENT_WEIGHT * float(emotion_field.get("arousal", 0.3))
            + _BASELINE_WEIGHT * float(memory.get("baseline_arousal", 0.3)),
            0.0,
            1.0,
        ),
        "stability": _clamp(float(emotion_field.get("stability", 0.7)), 0.0, 1.0),
    }
