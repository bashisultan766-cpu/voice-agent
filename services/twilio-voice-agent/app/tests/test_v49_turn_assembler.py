"""v4.9 — TurnAssembler unit tests."""
from __future__ import annotations

import asyncio
import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.config import Settings
from app.voice.turn_assembler import TurnAssembler


def _settings() -> Settings:
    return Settings(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_DIGIT_COLLECTION_SILENCE_MS=100,
        VOICE_EMAIL_COLLECTION_SILENCE_MS=100,
        VOICE_MIN_FINAL_SILENCE_MS=100,
        VOICE_TURN_ASSEMBLER_DEBOUNCE_MS=100,
    )


class TestTurnAssembler:
    @pytest.mark.asyncio
    async def test_fragmented_isbn_merged(self):
        asm = TurnAssembler(settings=_settings())
        emitted: list[str] = []

        async def on_emit(text: str) -> None:
            emitted.append(text)

        await asm.ingest("9 7 9 8 9 9 8 6.", on_emit, call_sid="CA01")
        await asm.ingest("2 7 0 0 2.", on_emit, call_sid="CA01")
        await asyncio.sleep(0.2)
        assert len(emitted) == 1
        digits = "".join(c for c in emitted[0] if c.isdigit())
        assert len(digits) == 13

    @pytest.mark.asyncio
    async def test_fragmented_email_merged(self):
        asm = TurnAssembler(settings=_settings())
        emitted: list[str] = []

        async def on_emit(text: str) -> None:
            emitted.append(text)

        await asm.ingest("Bashi Sultan", on_emit, call_sid="CA02")
        await asm.ingest("7 6 6 at gmail dot com", on_emit, call_sid="CA02")
        await asyncio.sleep(0.2)
        assert len(emitted) == 1
        assert "gmail" in emitted[0].lower()

    @pytest.mark.asyncio
    async def test_digit_fragment_not_unknown_early(self):
        asm = TurnAssembler(settings=_settings())
        emitted: list[str] = []

        async def on_emit(text: str) -> None:
            emitted.append(text)

        await asm.ingest("9 7 9 8", on_emit, call_sid="CA03")
        assert len(emitted) == 0

    @pytest.mark.asyncio
    async def test_normal_greeting_debounced(self):
        asm = TurnAssembler(settings=_settings())
        emitted: list[str] = []

        async def on_emit(text: str) -> None:
            emitted.append(text)

        await asm.ingest("Hello. How are you?", on_emit, call_sid="CA04")
        assert len(emitted) == 0
        await asyncio.sleep(0.2)
        assert len(emitted) == 1
        assert "hello" in emitted[0].lower()

    @pytest.mark.asyncio
    async def test_wait_extends_buffer(self):
        asm = TurnAssembler(settings=_settings())
        emitted: list[str] = []

        async def on_emit(text: str) -> None:
            emitted.append(text)

        await asm.ingest("9 7 9 8", on_emit, call_sid="CA05")
        await asm.ingest("wait wait", on_emit, call_sid="CA05")
        await asyncio.sleep(0.2)
        assert len(emitted) == 0

    @pytest.mark.asyncio
    async def test_repeat_again_resets(self):
        asm = TurnAssembler(settings=_settings())
        emitted: list[str] = []

        async def on_emit(text: str) -> None:
            emitted.append(text)

        await asm.ingest("9 7 9 8 9 9 8 6", on_emit, call_sid="CA06")
        await asm.ingest("repeat again", on_emit, call_sid="CA06")
        assert asm._state.buffer == ""

    @pytest.mark.asyncio
    async def test_no_duplicate_emit(self):
        asm = TurnAssembler(settings=_settings())
        emitted: list[str] = []

        async def on_emit(text: str) -> None:
            emitted.append(text)

        isbn = "9 7 9 8 9 9 3 8 6 1 8 0 7"
        await asm.ingest(isbn, on_emit, call_sid="CA07")
        await asm.ingest(isbn, on_emit, call_sid="CA07")
        assert len(emitted) == 1
