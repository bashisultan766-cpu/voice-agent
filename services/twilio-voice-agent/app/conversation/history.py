"""
ConversationHistory — interruption-safe conversation state for live voice.

Rules:
- Never stores role="tool" messages.
- Never stores assistant tool_calls.
- On interrupt (clear_inflight_turn), discards partial assistant turn.
- snapshot_for_composer() returns only system/user/assistant text messages.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

_MAX_TURNS = 20


@dataclass
class ConversationHistory:
    _messages: list[dict[str, Any]] = field(default_factory=list)
    _inflight_user: str = ""
    _inflight_assistant: str = ""

    def set_system(self, content: str) -> None:
        """Set or replace system message."""
        self._messages = [m for m in self._messages if m.get("role") != "system"]
        self._messages.insert(0, {"role": "system", "content": content})

    def add_user_turn(self, text: str) -> None:
        """Record the incoming user text. Call before workers run."""
        self._inflight_user = text
        self._inflight_assistant = ""

    def add_assistant_text(self, text: str) -> None:
        """Commit a completed assistant turn after successful streaming."""
        if not text.strip():
            return
        if self._inflight_user:
            self._messages.append({"role": "user", "content": self._inflight_user})
            self._inflight_user = ""
        self._messages.append({"role": "assistant", "content": text})
        self._inflight_assistant = ""
        # Trim to max turns (system + last N user/assistant pairs)
        system = [m for m in self._messages if m["role"] == "system"]
        other = [m for m in self._messages if m["role"] != "system"]
        if len(other) > _MAX_TURNS:
            other = other[-_MAX_TURNS:]
        self._messages = system + other

    def clear_inflight_turn(self) -> None:
        """Caller interrupted. Discard partial state. Do NOT commit user text."""
        self._inflight_user = ""
        self._inflight_assistant = ""

    def add_system_event(self, event: str) -> None:
        """Log a brief system event (not stored as OpenAI role)."""
        logger.debug("history_event: %s", event[:120])

    def snapshot_for_composer(self) -> list[dict[str, Any]]:
        """
        Return messages safe for OpenAI.
        Only system/user/assistant roles; never tool or tool_calls.
        """
        safe = []
        for m in self._messages:
            role = m.get("role", "")
            if role not in ("system", "user", "assistant"):
                continue
            content = m.get("content")
            if content is None:
                continue
            safe.append({"role": role, "content": content})
        return safe

    def to_legacy_list(self) -> list[dict[str, Any]]:
        """Return as list compatible with SessionState.history format."""
        return self.snapshot_for_composer()

    def __len__(self) -> int:
        return len(self._messages)
