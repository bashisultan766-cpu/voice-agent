from __future__ import annotations
from typing import Optional
from twilio.twiml.voice_response import VoiceResponse, Gather, Say, Play, Hangup
from app.config import settings


def build_gather_twiml(
    prompt: str,
    action_url: str,
    voice: str = "Polly.Joanna",
    timeout: int = 5,
    speech_timeout: str = "auto",
    play_url: Optional[str] = None,
) -> str:
    """Return TwiML that speaks a prompt then waits for user speech."""
    response = VoiceResponse()
    gather = Gather(
        input="speech",
        action=action_url,
        method="POST",
        timeout=timeout,
        speech_timeout=speech_timeout,
        language="en-US",
    )
    if play_url:
        gather.play(play_url)
    else:
        gather.say(prompt, voice=voice)
    response.append(gather)
    # Fallback if no speech detected
    response.say("I didn't hear anything. Please call back if you need assistance.")
    return str(response)


def build_say_twiml(text: str, voice: str = "Polly.Joanna") -> str:
    """Return TwiML that says text and hangs up."""
    response = VoiceResponse()
    response.say(text, voice=voice)
    response.hangup()
    return str(response)


def build_ack_redirect_twiml(
    ack_text: str,
    redirect_url: str,
    voice: str = "Polly.Joanna",
) -> str:
    """
    TwiML: speak an acknowledgement phrase then immediately redirect.
    Used by the fast-ack two-hop pattern so the caller hears something
    within ~1 s while the background task runs.
    """
    response = VoiceResponse()
    response.say(ack_text, voice=voice)
    response.redirect(redirect_url, method="POST")
    return str(response)


def build_pause_redirect_twiml(pause_secs: int, redirect_url: str) -> str:
    """
    TwiML: pause briefly then redirect.
    Used by /ready/{turn_id} to hold the call while waiting for the
    background processing result.
    """
    response = VoiceResponse()
    response.pause(length=pause_secs)
    response.redirect(redirect_url, method="POST")
    return str(response)


def validate_twilio_signature(
    auth_token: str,
    signature: str,
    url: str,
    params: dict,
) -> bool:
    if not settings.VALIDATE_TWILIO_SIGNATURES:
        return True
    from twilio.request_validator import RequestValidator
    validator = RequestValidator(auth_token)
    return validator.validate(url, params, signature)
