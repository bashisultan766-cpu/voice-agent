"""Twilio ConversationRelay + ElevenLabs voice configuration (2026 enterprise standards)."""
from __future__ import annotations

from typing import Literal, TypedDict

TelephonyAudioFormat = Literal["ulaw_8000", "pcm_16000"]

# ~20 ms of ulaw @ 8 kHz — lower bound for smooth stream playback.
MIN_AUDIO_CHUNK_BYTES = 160
# ~50 ms of ulaw @ 8 kHz — upper bound to limit mouth-to-ear delay.
MAX_AUDIO_CHUNK_BYTES = 400

_TWILIO_MODEL_ALIASES: dict[str, str] = {
    "eleven_flash_v2_5": "flash_v2_5",
    "eleven_flash_v2": "flash_v2",
    "eleven_turbo_v2_5": "turbo_v2_5",
    "eleven_turbo_v2": "turbo_v2",
    "eleven_multilingual_v2": "multilingual_v2",
}


class ElevenLabsVoiceSettings(TypedDict):
    stability: float
    similarity_boost: float
    style: float
    use_speaker_boost: bool


def normalize_twilio_elevenlabs_model(model: str) -> str:
    """Map ElevenLabs API model IDs to Twilio ConversationRelay slugs."""
    trimmed = (model or "").strip()
    if not trimmed:
        return ""
    if trimmed in _TWILIO_MODEL_ALIASES:
        return _TWILIO_MODEL_ALIASES[trimmed]
    if trimmed.startswith("eleven_"):
        return trimmed[len("eleven_") :]
    return trimmed


def format_twilio_voice_tuning(speed: float, stability: float, similarity: float) -> str:
    """Format speed_stability_similarity suffix for Twilio ConversationRelay voice attr."""

    def _fmt(value: float) -> str:
        rounded = round(value * 100) / 100
        return f"{rounded:.1f}" if rounded == int(rounded) else str(rounded)

    return f"{_fmt(speed)}_{_fmt(stability)}_{_fmt(similarity)}"


def get_elevenlabs_voice_settings(
    *,
    stability: float = 0.70,
    similarity_boost: float = 0.85,
    style: float = 0.0,
) -> ElevenLabsVoiceSettings:
    """Enterprise voice settings — high stability, strict clone fidelity, no style exaggeration."""
    return {
        "stability": stability,
        "similarity_boost": similarity_boost,
        "style": style,
        "use_speaker_boost": True,
    }


def resolve_telephony_output_format(
    configured: str,
    *,
    log_coercion=None,
) -> TelephonyAudioFormat:
    """Coerce to Twilio-native telephony format — MP3 causes double-encoding on phone lines."""
    normalized = (configured or "ulaw_8000").strip().lower()
    if normalized == "mp3_44100_128":
        if log_coercion:
            log_coercion("mp3_44100_128", "ulaw_8000")
        return "ulaw_8000"
    if normalized == "pcm_16000":
        return "pcm_16000"
    return "ulaw_8000"


def telephony_chunk_bounds(format: TelephonyAudioFormat) -> tuple[int, int]:
    if format == "pcm_16000":
        return 640, 1600
    return MIN_AUDIO_CHUNK_BYTES, MAX_AUDIO_CHUNK_BYTES


def content_type_for_format(format: TelephonyAudioFormat) -> str:
    if format == "ulaw_8000":
        return "audio/basic"
    return "audio/L16"


class AudioChunkAccumulator:
    """Buffer variable-size ElevenLabs frames into 20–50 ms telephony chunks."""

    def __init__(self, min_bytes: int, max_bytes: int) -> None:
        self._min_bytes = min_bytes
        self._max_bytes = max_bytes
        self._pending = bytearray()

    def ingest(self, chunk: bytes) -> list[bytes]:
        if not chunk:
            return []
        self._pending.extend(chunk)
        ready: list[bytes] = []

        while len(self._pending) >= self._max_bytes:
            ready.append(bytes(self._pending[: self._max_bytes]))
            del self._pending[: self._max_bytes]

        if self._min_bytes <= len(self._pending) < self._max_bytes:
            ready.append(bytes(self._pending))
            self._pending.clear()

        return ready

    def drain(self) -> list[bytes]:
        if not self._pending:
            return []
        tail = bytes(self._pending)
        self._pending.clear()
        return [tail]


def normalize_audio_chunks(buffer: bytes, format: TelephonyAudioFormat = "ulaw_8000") -> bytes:
    """Re-chunk a complete buffer into telephony-aligned frames (20–50 ms)."""
    min_bytes, max_bytes = telephony_chunk_bounds(format)
    if len(buffer) <= min_bytes:
        return buffer
    acc = AudioChunkAccumulator(min_bytes, max_bytes)
    parts = acc.ingest(buffer) + acc.drain()
    return parts[0] if len(parts) == 1 else b"".join(parts)
