"""
TTS adapter — ElevenLabs direct API with telephony-native output format.

Primary live path is Twilio ConversationRelay text tokens (Twilio-side synthesis).
This module enforces ulaw_8000 / pcm_16000 and enterprise voice settings when
direct ElevenLabs streaming is used (cache prewarm, future audio relay).
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, AsyncIterator, NamedTuple

import httpx

from .voice_config import (
    ElevenLabsVoiceSettings,
    content_type_for_format,
    get_elevenlabs_voice_settings,
    normalize_audio_chunks,
    normalize_twilio_elevenlabs_model,
    resolve_telephony_output_format,
    AudioChunkAccumulator,
    telephony_chunk_bounds,
)

if TYPE_CHECKING:
    from ..config import Settings

logger = logging.getLogger(__name__)

TTS_STREAM_CRASH_LOG = "TTS_STREAM_CRASH_DETECTED"


class VoiceSynthesisResult(NamedTuple):
    audio: bytes
    content_type: str
    engine: str


def eleven_labs_model_id(settings: Settings) -> str:
    raw = (settings.VOICE_MODEL or "").strip()
    normalized = normalize_twilio_elevenlabs_model(raw)
    return f"eleven_{normalized}" if normalized else "eleven_turbo_v2_5"


def voice_settings_from_config(settings: Settings) -> ElevenLabsVoiceSettings:
    return get_elevenlabs_voice_settings(
        stability=settings.VOICE_STABILITY,
        similarity_boost=settings.VOICE_SIMILARITY,
        style=settings.VOICE_STYLE,
    )


def resolve_output_format(settings: Settings) -> str:
    return resolve_telephony_output_format(
        settings.TTS_AUDIO_FORMAT,
        log_coercion=lambda src, dst: logger.warning(
            "tts_format_coerced from=%s to=%s", src, dst
        ),
    )


async def synthesize_speech(
    text: str,
    settings: Settings,
    *,
    timeout_secs: float = 8.0,
) -> VoiceSynthesisResult | None:
    """Synthesize one utterance via ElevenLabs direct API (telephony format only)."""
    api_key = (settings.ELEVENLABS_API_KEY or "").strip()
    voice_id = (settings.VOICE_ID or settings.ELEVENLABS_VOICE_ID or "").strip()
    cleaned = (text or "").strip()
    if not api_key or not voice_id or not cleaned:
        return None

    output_format = resolve_output_format(settings)
    url = (
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"
        f"?output_format={output_format}"
    )
    payload = {
        "text": cleaned,
        "model_id": eleven_labs_model_id(settings),
        "voice_settings": voice_settings_from_config(settings),
        "optimize_streaming_latency": 2,
    }
    headers = {
        "xi-api-key": api_key,
        "Content-Type": "application/json",
        "Accept": content_type_for_format(output_format),  # type: ignore[arg-type]
    }

    try:
        async with httpx.AsyncClient(timeout=timeout_secs) as client:
            resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code != 200:
            logger.warning(
                "elevenlabs_tts_failed status=%s body=%s",
                resp.status_code,
                resp.text[:80],
            )
            return None
        raw = resp.content
        return VoiceSynthesisResult(
            audio=normalize_audio_chunks(raw, output_format),  # type: ignore[arg-type]
            content_type=resp.headers.get("content-type")
            or content_type_for_format(output_format),  # type: ignore[arg-type]
            engine="ElevenLabs",
        )
    except Exception as exc:
        logger.warning("elevenlabs_tts_error error=%s", exc)
        return None


async def synthesize_speech_stream(
    text: str,
    settings: Settings,
    *,
    timeout_secs: float = 15.0,
) -> AsyncIterator[bytes]:
    """Stream telephony-aligned audio chunks (20–50 ms frames, no MP3 metadata)."""
    api_key = (settings.ELEVENLABS_API_KEY or "").strip()
    voice_id = (settings.VOICE_ID or settings.ELEVENLABS_VOICE_ID or "").strip()
    cleaned = (text or "").strip()
    if not api_key or not voice_id or not cleaned:
        return

    output_format = resolve_output_format(settings)
    min_bytes, max_bytes = telephony_chunk_bounds(output_format)  # type: ignore[arg-type]
    accumulator = AudioChunkAccumulator(min_bytes, max_bytes)

    url = (
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"
        f"?output_format={output_format}"
    )
    payload = {
        "text": cleaned,
        "model_id": eleven_labs_model_id(settings),
        "voice_settings": voice_settings_from_config(settings),
        "optimize_streaming_latency": 2,
    }
    headers = {
        "xi-api-key": api_key,
        "Content-Type": "application/json",
        "Accept": content_type_for_format(output_format),  # type: ignore[arg-type]
    }

    try:
        async with httpx.AsyncClient(timeout=timeout_secs) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    logger.warning(
                        "elevenlabs_tts_failed status=%s body=%s",
                        resp.status_code,
                        body[:80],
                    )
                    return
                async for chunk in resp.aiter_bytes():
                    if chunk:
                        for frame in accumulator.ingest(chunk):
                            yield frame
        for frame in accumulator.drain():
            yield frame
    except Exception as exc:
        logger.error("%s error=%s stage=elevenlabs_stream", TTS_STREAM_CRASH_LOG, exc)
