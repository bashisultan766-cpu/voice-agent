from typing import Optional
from xml.etree.ElementTree import Element, SubElement, tostring

_XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>'

_LANGUAGE_MAP = {
    "ar": "ar-SA",
    "en": "en-US",
}


def _render(root: Element) -> str:
    return _XML_HEADER + tostring(root, encoding="unicode")


def gather_twiml(
    action_url: str,
    play_url: Optional[str] = None,
    speech_timeout: str = "auto",
    language: str = "en",
) -> str:
    """
    Standard turn TwiML: optionally play audio, then collect next speech input.
    """
    response = Element("Response")

    if play_url:
        SubElement(response, "Play").text = play_url

    SubElement(
        response,
        "Gather",
        attrib={
            "input": "speech",
            "action": action_url,
            "method": "POST",
            "speechTimeout": speech_timeout,
            "language": _LANGUAGE_MAP.get(language, "en-US"),
        },
    )

    # Fallback if no speech detected — re-hit the gather endpoint
    SubElement(response, "Redirect", attrib={"method": "POST"}).text = action_url

    return _render(response)


def hangup_twiml(play_url: Optional[str] = None) -> str:
    """Play a closing message then hang up."""
    response = Element("Response")
    if play_url:
        SubElement(response, "Play").text = play_url
    SubElement(response, "Hangup")
    return _render(response)


def reject_twiml() -> str:
    """Immediately reject a call (used when no agent config found)."""
    response = Element("Response")
    SubElement(response, "Reject", attrib={"reason": "rejected"})
    return _render(response)


def media_stream_twiml(base_url: str) -> str:
    """
    TwiML that opens a bidirectional Twilio Media Streams WebSocket.
    The call stays alive for as long as the WebSocket remains open.

    base_url must be https:// — the scheme is rewritten to wss:// for the stream URL.
    """
    ws_url = (
        base_url.rstrip("/")
        .replace("https://", "wss://")
        .replace("http://", "ws://")
    )
    response = Element("Response")
    connect = SubElement(response, "Connect")
    SubElement(connect, "Stream", attrib={"url": f"{ws_url}/ws/stream"})
    return _render(response)
