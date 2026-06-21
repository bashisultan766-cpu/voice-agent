"""Audio format conversion: µ-law ↔ PCM ↔ base64 (Twilio ↔ OpenAI TTS ↔ Deepgram)."""
from __future__ import annotations

from .audioop_compat import audioop
import base64


def mulaw_to_pcm16(mulaw_bytes: bytes) -> bytes:
    """Decode 8kHz G.711 µ-law → 16-bit signed PCM at same 8kHz sample rate."""
    return audioop.ulaw2lin(mulaw_bytes, 2)


def pcm16_to_mulaw(pcm_bytes: bytes, src_rate: int = 24000) -> bytes:
    """Resample PCM from src_rate Hz → 8kHz, then encode as G.711 µ-law."""
    if src_rate != 8000:
        pcm_bytes, _ = audioop.ratecv(pcm_bytes, 2, 1, src_rate, 8000, None)
    return audioop.lin2ulaw(pcm_bytes, 2)


def base64_to_mulaw(b64: str) -> bytes:
    """Decode a Twilio media payload (base64-encoded µ-law) → raw mulaw bytes."""
    return base64.b64decode(b64)


def pcm16_to_twilio_payload(pcm_bytes: bytes, src_rate: int = 24000) -> str:
    """Full pipeline: PCM → 8kHz µ-law → base64 string for one Twilio media message."""
    return base64.b64encode(pcm16_to_mulaw(pcm_bytes, src_rate)).decode()


def chunk_for_twilio(mulaw_bytes: bytes, frame_ms: int = 20) -> list[bytes]:
    """
    Split µ-law audio into 20 ms frames (160 bytes at 8 kHz × 1 byte/sample).
    Twilio expects one frame per WebSocket message for correct pacing.
    """
    frame_size = 8000 * frame_ms // 1000  # 160 bytes
    return [mulaw_bytes[i : i + frame_size] for i in range(0, len(mulaw_bytes), frame_size)]
