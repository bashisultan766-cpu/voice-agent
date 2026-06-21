"""Fail-fast startup validation for production voice-agent deployment."""
from __future__ import annotations

from .config import Settings

_REQUIRED_SECRETS = (
    "OPENAI_API_KEY",
    "DEEPGRAM_API_KEY",
    "TWILIO_AUTH_TOKEN",
)


def validate_startup_env(settings: Settings) -> None:
    """
    Crash the process if mandatory voice pipeline configuration is missing or insecure.
    Called from application lifespan before accepting traffic.
    """
    errors: list[str] = []

    base = settings.BASE_URL.strip()
    if not base.startswith("https://"):
        errors.append(
            f"BASE_URL must be https:// (got {base!r}). "
            "Twilio Media Streams requires wss:// derived from this URL."
        )

    for key in _REQUIRED_SECRETS:
        if not getattr(settings, key, "").strip():
            errors.append(f"{key} is required")

    if errors:
        raise RuntimeError(
            "Voice agent startup blocked — fix environment:\n  - "
            + "\n  - ".join(errors)
        )
