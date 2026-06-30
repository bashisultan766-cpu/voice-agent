"""Long-term emotional drift on SessionState."""
from __future__ import annotations

from app.state.emotion_memory import (
    default_emotional_memory,
    effective_emotion_field,
    ensure_emotional_memory,
    note_interrupt_memory,
    record_emotion_turn,
)
from app.state.models import SessionState
from app.voice.voice_response_formatter import default_emotion_field, evolve_emotion_field


def _session() -> SessionState:
    return SessionState(
        session_id="emo",
        call_sid="CAemo1",
        from_number="+1",
        to_number="+2",
    )


def test_session_has_emotional_memory_defaults():
    session = _session()
    assert session.emotional_memory == default_emotional_memory()


def test_repeated_success_raises_baseline_valence():
    session = _session()
    start = session.emotional_memory["baseline_valence"]
    for _ in range(5):
        record_emotion_turn(session, had_success=True)
    assert session.emotional_memory["baseline_valence"] > start


def test_repeated_failure_lowers_baseline_valence():
    session = _session()
    start = session.emotional_memory["baseline_valence"]
    for _ in range(5):
        record_emotion_turn(session, had_failure=True)
    assert session.emotional_memory["baseline_valence"] < start


def test_repeated_interrupts_raise_baseline_arousal():
    session = _session()
    start = session.emotional_memory["baseline_arousal"]
    for _ in range(4):
        note_interrupt_memory(session)
    assert session.emotional_memory["baseline_arousal"] > start


def test_effective_emotion_blends_baseline():
    current = {"valence": 0.5, "arousal": 0.2, "stability": 0.8}
    memory = {"baseline_valence": -0.4, "baseline_arousal": 0.6}
    blended = effective_emotion_field(current, memory)
    assert blended["valence"] == 0.7 * 0.5 + 0.3 * -0.4
    assert blended["arousal"] == 0.7 * 0.2 + 0.3 * 0.6
    assert blended["stability"] == 0.8


def test_baseline_drift_is_gradual():
    session = _session()
    start = session.emotional_memory["baseline_valence"]
    record_emotion_turn(session, had_success=True)
    delta = session.emotional_memory["baseline_valence"] - start
    assert 0 < delta < 0.05


def test_evolve_emotion_returns_blended_field():
    session = _session()
    session.emotional_memory["baseline_valence"] = 0.4
    blended = evolve_emotion_field(
        session,
        response_text="Your order is paid and shipped.",
        user_text="thanks",
    )
    assert blended["valence"] > session.emotion_field["valence"] * 0.69
    assert session.emotional_memory["baseline_valence"] > 0.4
