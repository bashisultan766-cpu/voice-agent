"""
Integration test: OpenAI TTS → PCM → mulaw 8 kHz → DeepgramSTT → printed transcript.

Run directly (requires DEEPGRAM_API_KEY + OPENAI_API_KEY in .env or environment):
    python tests/test_deepgram_stt.py

Run via pytest (skipped by default unless -m integration is passed):
    pytest tests/test_deepgram_stt.py -m integration -s

The test synthesizes a short phrase with OpenAI TTS (PCM 24 kHz), converts it to
8 kHz µ-law using the same audio pipeline that Twilio sends, then streams it to
Deepgram in 20 ms frames — identical to how the real WS handler will feed audio.
"""
from __future__ import annotations

import asyncio
import os
import sys

# Allow running as a plain script from the repo root or the service directory.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from dotenv import load_dotenv

load_dotenv()

_TEST_PHRASE = (
    "Hello, I'd like to check on my order number one two three four five. "
    "Can you help me find out when it will arrive?"
)
_CHUNK_BYTES = 160   # 20 ms of 8 kHz µ-law


async def _run() -> list[str]:
    dg_key = os.environ.get("DEEPGRAM_API_KEY", "")
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if not dg_key:
        raise RuntimeError("DEEPGRAM_API_KEY is not set")
    if not openai_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    # ── 1. Synthesize test speech with OpenAI TTS (PCM 24 kHz) ───────────────
    from openai import AsyncOpenAI
    from app.pipeline.audio import pcm16_to_mulaw
    from app.pipeline.stt import DeepgramSTT

    print(f"\nSynthesizing: {_TEST_PHRASE!r}")
    client = AsyncOpenAI(api_key=openai_key)
    tts_response = await client.audio.speech.create(
        model="tts-1",
        voice="nova",
        input=_TEST_PHRASE,
        response_format="pcm",   # 24 kHz, 16-bit, mono — same as the greeting path
    )
    pcm_bytes: bytes = tts_response.content

    # ── 2. Convert to 8 kHz µ-law (Twilio wire format) ───────────────────────
    mulaw_bytes = pcm16_to_mulaw(pcm_bytes, src_rate=24000)
    print(f"Audio: {len(pcm_bytes):,} B PCM → {len(mulaw_bytes):,} B mulaw "
          f"({len(mulaw_bytes) / 8000:.2f}s at 8 kHz)")

    # ── 3. Open Deepgram and stream audio in 20 ms frames ────────────────────
    stt = DeepgramSTT(api_key=dg_key)
    await stt.start()

    finals: list[str] = []

    async def _feed() -> None:
        for i in range(0, len(mulaw_bytes), _CHUNK_BYTES):
            await stt.send(mulaw_bytes[i : i + _CHUNK_BYTES])
            await asyncio.sleep(0.02)   # real-time pacing: 1 frame per 20 ms
        print("  [feeder] audio exhausted — closing STT in 1.2 s …")
        await asyncio.sleep(1.2)        # let Deepgram emit final transcript
        await stt.close()

    async def _consume() -> None:
        async for ev in stt.events():
            if ev.speech_started:
                print("  [speech_started]")
            elif ev.speech_final and not ev.text:
                print("  [UtteranceEnd]")
            elif ev.text:
                tag = "FINAL  " if ev.is_final else "interim"
                sf  = " ← speech_final" if ev.speech_final else ""
                print(f"  [{tag}] {ev.text!r}  conf={ev.confidence:.2f}{sf}")
                if ev.is_final:
                    finals.append(ev.text)

    await asyncio.gather(_feed(), _consume())
    return finals


# ── pytest entry point ────────────────────────────────────────────────────────

@pytest.mark.integration
@pytest.mark.asyncio
async def test_deepgram_roundtrip() -> None:
    """Confirm Deepgram returns a transcript that contains expected keywords."""
    if not os.environ.get("DEEPGRAM_API_KEY") or not os.environ.get("OPENAI_API_KEY"):
        pytest.skip("DEEPGRAM_API_KEY and OPENAI_API_KEY required for integration test")
    transcripts = await _run()
    assert transcripts, "Deepgram returned no final transcripts"
    full = " ".join(transcripts).lower()
    # Loose match — TTS pronunciation may vary slightly
    assert any(kw in full for kw in ("order", "check", "arrive", "hello")), (
        f"Transcript missing expected keywords: {full!r}"
    )


# ── standalone entry point ────────────────────────────────────────────────────

if __name__ == "__main__":
    results = asyncio.run(_run())
    print(f"\nFinal transcripts ({len(results)}):")
    for t in results:
        print(f"  {t!r}")
    if not results:
        print("  WARNING: no final transcripts received — check your API keys and audio.")
        sys.exit(1)
