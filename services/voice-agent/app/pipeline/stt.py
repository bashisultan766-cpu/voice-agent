"""
Streaming speech-to-text interface and providers.

TODO (Milestone 3 — WebSocket pipeline):
    Implement the streaming STT layer here.

Interface contract (to be implemented):
    class STTProvider(ABC):
        async def stream(self, audio_chunk: bytes) -> AsyncIterator[STTEvent]: ...

    @dataclass
    class STTEvent:
        text: str           # transcript text (partial or final)
        is_final: bool      # True when Deepgram fires speech_final
        confidence: float

Providers to implement:
    - DeepgramSTT  — connect to wss://api.deepgram.com/v1/listen
                     use Nova-2 model, encoding=mulaw, sample_rate=8000
                     enable endpointing (utterance_end_ms=1000) and vad_events
    - OpenAISTT    — fallback: buffer audio → POST to /v1/audio/transcriptions
                     (not truly streaming, higher latency)

Selected provider is controlled by Settings.STT_PROVIDER.

Barge-in integration:
    When a speech_started event arrives while TTS is playing,
    the pipeline must call tts_provider.cancel() immediately.
    The barge-in signal flows: Deepgram event → ws/media_stream.py → tts cancel.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator


@dataclass
class STTEvent:
    text: str
    is_final: bool
    confidence: float = 0.0
    speech_final: bool = False     # Deepgram speech_final — triggers LLM call


class STTProvider(ABC):
    @abstractmethod
    async def stream(self, audio_chunk: bytes) -> AsyncIterator[STTEvent]:
        """Feed a raw audio chunk and yield transcript events."""
        ...

    @abstractmethod
    async def close(self) -> None:
        """Flush and close the STT connection."""
        ...
