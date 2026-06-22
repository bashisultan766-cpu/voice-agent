from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    from ..config import get_settings
    s = get_settings()
    return {
        "ok": True,
        "service": "twilio-voice-agent",
        "runtime": "twilio_conversation_relay",
        "tts_provider": s.VOICE_TTS_PROVIDER,
        "voice_configured": bool(s.VOICE_ID) if s.VOICE_TTS_PROVIDER.lower() == "elevenlabs" else True,
    }
