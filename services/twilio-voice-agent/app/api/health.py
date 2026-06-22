from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "service": "twilio-voice-agent",
        "runtime": "twilio_conversation_relay",
    }
