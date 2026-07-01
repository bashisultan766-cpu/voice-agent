"""VoiceEmissionScheduler — one active TTS emission per session."""
from __future__ import annotations

import asyncio

import pytest

from app.runtime.voice_commerce_runtime import (
    VoiceEmissionScheduler,
    ensure_email_spell_inactive_before_payment,
    flush_voice_queue,
    flush_voice_queue_before_critical_action,
    is_speaking,
    schedule_voice_output,
    wait_for_speech_completion_before_next_action,
)
from app.state.models import SessionState


def _session() -> SessionState:
    return SessionState(
        session_id="emit",
        call_sid="CAemit01",
        from_number="+1",
        to_number="+2",
    )


@pytest.mark.asyncio
async def test_serializes_non_interruptible_emissions():
    session = _session()
    sent: list[dict] = []

    async def send(msg: dict) -> None:
        sent.append(msg)
        if msg.get("token"):
            session.is_speaking = True
        if msg.get("last"):
            session.is_speaking = False

    session._active_voice_send = send  # type: ignore[attr-defined]

    await schedule_voice_output(
        session, "First line here for the caller.", 0, send=send, interruptible=False,
    )
    await schedule_voice_output(
        session, "Second line here for the caller.", 0, send=send, interruptible=False,
    )

    tokens = [m["token"] for m in sent if m.get("token")]
    assert len(tokens) == 2
    assert "First" in tokens[0]
    assert "Second" in tokens[1]
    assert not is_speaking(session)


@pytest.mark.asyncio
async def test_queues_while_speaking_non_interruptible():
    session = _session()
    session.is_speaking = True
    sent: list[dict] = []

    async def send(msg: dict) -> None:
        sent.append(msg)

    await schedule_voice_output(
        session, "Queued while active speech plays.", 0, send=send, interruptible=False,
    )

    pending = flush_voice_queue(session)
    assert pending
    assert flush_voice_queue(session) == []


@pytest.mark.asyncio
async def test_interruptible_emits_while_active():
    session = _session()
    session.is_speaking = True
    sent: list[dict] = []

    async def send(msg: dict) -> None:
        sent.append(msg)
        if msg.get("last"):
            session.is_speaking = False

    await schedule_voice_output(
        session, "Preempting line for urgent update.", 1, send=send, interruptible=True,
    )

    assert any(m.get("token") for m in sent)


@pytest.mark.asyncio
async def test_higher_priority_before_lower_in_queue():
    session = _session()
    scheduler = VoiceEmissionScheduler.instance()
    session._voice_emission_active = True  # type: ignore[attr-defined]

    async def noop_send(_msg: dict) -> None:
        return None

    await scheduler.schedule_voice_output(
        session, "Low priority message here.", 0, send=noop_send, interruptible=False,
    )
    await scheduler.schedule_voice_output(
        session, "High priority message here.", 5, send=noop_send, interruptible=False,
    )

    queue = session._voice_emission_queue  # type: ignore[attr-defined]
    assert len(queue) == 2
    assert queue[0].priority == 5


@pytest.mark.asyncio
async def test_flush_voice_queue_clears_pending():
    session = _session()
    session.is_speaking = True

    async def noop_send(_msg: dict) -> None:
        return None

    await schedule_voice_output(
        session, "Pending speech should be flushed.", 0, send=noop_send, interruptible=False,
    )
    flushed = flush_voice_queue(session)
    assert flushed
    assert flush_voice_queue(session) == []


@pytest.mark.asyncio
async def test_wait_for_speech_completion_before_next_action():
    session = _session()
    session.is_speaking = True

    async def clear_speaking(_msg: dict) -> None:
        session.is_speaking = False

    session._active_voice_send = clear_speaking  # type: ignore[attr-defined]

    async def waiter():
        await wait_for_speech_completion_before_next_action(session, timeout=1.0)

    wait_task = asyncio.create_task(waiter())
    await asyncio.sleep(0.05)
    assert not wait_task.done()
    session.is_speaking = False
    await wait_task


@pytest.mark.asyncio
async def test_flush_before_critical_action_waits_for_idle():
    session = _session()
    flushed = await flush_voice_queue_before_critical_action(session)
    assert flushed == []
    assert not is_speaking(session)


@pytest.mark.asyncio
async def test_email_spell_blocks_payment_priority_lane():
    session = _session()
    session._email_spell_emission_active = True  # type: ignore[attr-defined]
    session.is_speaking = True

    async def waiter():
        await ensure_email_spell_inactive_before_payment(session, timeout=0.2)

    task = asyncio.create_task(waiter())
    await asyncio.sleep(0.05)
    assert not task.done()
    session._email_spell_emission_active = False  # type: ignore[attr-defined]
    session.is_speaking = False
    await task
