"""Structured JSON logs for live Twilio Media Streams call debugging."""
from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger("voice.call_debug")


def call_log(event: str, **fields: Any) -> None:
    payload = {"event": event, **fields}
    logger.info("call_debug %s", json.dumps(payload, default=str))
