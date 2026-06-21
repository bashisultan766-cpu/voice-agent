"""
OpenAI TTS with HTTP streaming for low-latency voice output.

Two modes:
    synthesize()    — full synthesis; use for short phrases (<2s audio).
    stream_mulaw()  — HTTP-streaming generator; starts sending audio before
                      synthesis is complete. Use for LLM sentence responses.

Output:  µ-law 8kHz mono bytes  (Twilio Media Streams format).
         Caller must chunk into 160-byte (20ms) frames via pipeline.audio.chunk_for_twilio().
"""
from __future__ import annotations

import logging
from typing import AsyncIterator

from openai import AsyncOpenAI

from .audio import pcm16_to_mulaw
from .audioop_compat import audioop

logger = logging.getLogger(__name__)


class OpenAIStreamingTTS:
    """
    Wraps OpenAI TTS for streaming voice output.

    Both methods output raw µ-law 8kHz bytes. No Twilio framing here —
    that's done by the orchestrator via chunk_for_twilio().
    """

    def __init__(
        self,
        client: AsyncOpenAI,
        model: str = "tts-1",
        voice: str = "nova",
    ) -> None:
        self._client = client
        self._model = model
        self._voice = voice

    async def synthesize(self, text: str) -> bytes:
        """
        Full (non-streaming) synthesis. Returns complete µ-law bytes.
        Best for: greeting, filler phrases — anything where you need the
        full audio before starting playback.
        """
        response = await self._client.audio.speech.create(
            model=self._model,
            voice=self._voice,
            input=text,
            response_format="pcm",  # 24kHz PCM, no container
        )
        return pcm16_to_mulaw(response.content, src_rate=24000)

    async def stream_mulaw(self, text: str) -> AsyncIterator[bytes]:
        """
        HTTP-streaming synthesis: yield µ-law chunks as OpenAI generates them.

        Latency benefit: first chunk arrives before full synthesis is done.
        Maintains audioop.ratecv state across HTTP chunks for clean resampling.
        PCM alignment: audioop requires 2-byte aligned input; unaligned tail
        is carried over to the next chunk via `carry`.
        """
        ratecv_state = None
        carry = b""  # partial PCM sample from previous chunk

        async with self._client.audio.speech.with_streaming_response.create(
            model=self._model,
            voice=self._voice,
            input=text,
            response_format="pcm",  # 24kHz 16-bit mono
        ) as response:
            async for raw in response.iter_bytes(chunk_size=4096):
                chunk = carry + raw
                tail = len(chunk) % 2  # audioop needs 2-byte (16-bit) alignment
                carry = chunk[-tail:] if tail else b""
                chunk = chunk[:-tail] if tail else chunk
                if not chunk:
                    continue
                resampled, ratecv_state = audioop.ratecv(
                    chunk, 2, 1, 24000, 8000, ratecv_state
                )
                if resampled:
                    yield audioop.lin2ulaw(resampled, 2)

        # Flush any leftover carry bytes
        if carry and len(carry) % 2 == 0:
            resampled, _ = audioop.ratecv(carry, 2, 1, 24000, 8000, ratecv_state)
            if resampled:
                yield audioop.lin2ulaw(resampled, 2)
