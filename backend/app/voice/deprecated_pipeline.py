"""Legacy Twilio voice webhooks — disabled in favor of services/voice-agent."""
from __future__ import annotations

from fastapi import HTTPException

DEPRECATED_VOICE_PIPELINE_MESSAGE = (
    "Deprecated: use services/voice-agent Media Streams pipeline"
)


def reject_legacy_voice_pipeline() -> None:
    raise HTTPException(status_code=410, detail=DEPRECATED_VOICE_PIPELINE_MESSAGE)
