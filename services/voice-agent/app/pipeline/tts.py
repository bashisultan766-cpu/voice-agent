"""
Streaming TTS interface and providers.

TODO (Milestone 3 — WebSocket pipeline):
    Implement the streaming TTS layer here. This module will subsume
    the existing app/tts/ directory once streaming is wired.

Interface contract (to be implemented):
    class TTSProvider(ABC):
        async def stream(self, text: str) -> AsyncIterator[bytes]: ...
        async def cancel(self) -> None: ...   # barge-in: stop playback immediately

Providers to implement:
    - OpenAITTS    — POST to /v1/audio/speech with response_format=pcm
                     stream response body as audio chunks
                     re-sample 24kHz PCM → 8kHz mulaw for Twilio via audio.py
    - ElevenLabsTTS — connect to wss://api.elevenlabs.io/v1/text-to-speech/{id}/stream-input
                      send text chunks, receive MP3 chunks, re-sample for Twilio

Selected provider is controlled by Settings.TTS_PROVIDER.

Sentence-streaming:
    The LLM token stream is split into sentences by pipeline/llm.py.
    Each sentence is passed to tts.stream() independently so audio starts
    before the full LLM response is complete.

Audio format:
    Twilio Media Streams expects 8kHz mulaw base64-encoded audio.
    All providers must output raw PCM bytes; audio.py handles format conversion.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncIterator


class StreamingTTSProvider(ABC):
    @abstractmethod
    async def stream(self, text: str, voice_id: str = "", speed: float = 1.0) -> AsyncIterator[bytes]:
        """Yield raw PCM audio chunks for the given text."""
        ...

    @abstractmethod
    async def cancel(self) -> None:
        """Stop any in-progress synthesis (barge-in support)."""
        ...
