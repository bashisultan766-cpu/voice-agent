"""
Redis-only session state for VOICE_AGENT_OS_V2.

No in-process SessionState, call_memory, or legacy FSM fields.
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)

_KEY_PREFIX = "v2:session:"
_DEFAULT_TTL = 7200


@dataclass
class EmailState:
  pending: str = ""
  confirmed: str = ""
  awaiting_confirmation: bool = False


@dataclass
class OrderContext:
  last_number: str = ""
  last_lookup: dict[str, Any] = field(default_factory=dict)
  verified_numbers: list[str] = field(default_factory=list)


@dataclass
class V2SessionState:
    """Canonical per-call state — sole source of truth."""

    call_sid: str
    from_number: str = ""
    to_number: str = ""
    session_id: str = ""

    conversation_stage: str = "idle"
    cart: list[dict[str, Any]] = field(default_factory=list)
    email: EmailState = field(default_factory=EmailState)
    order_context: OrderContext = field(default_factory=OrderContext)
    last_tool_result: dict[str, Any] = field(default_factory=dict)
    last_response: str = ""

    turn_id: int = 0
    interrupt_flag: bool = False

    history: list[dict[str, str]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    # v2.1 append-only turn memory contract
    turn_history: list[dict[str, Any]] = field(default_factory=list)
    tool_history: list[dict[str, Any]] = field(default_factory=list)
    state_transitions: list[dict[str, Any]] = field(default_factory=list)

    def snapshot(self) -> dict[str, Any]:
        """Read-only dict for planner input."""
        return {
            "call_sid": self.call_sid,
            "conversation_stage": self.conversation_stage,
            "cart": list(self.cart),
            "email": {
                "pending": self.email.pending,
                "confirmed": self.email.confirmed,
                "awaiting_confirmation": self.email.awaiting_confirmation,
            },
            "order_context": {
                "last_number": self.order_context.last_number,
                "last_lookup": dict(self.order_context.last_lookup),
                "verified_numbers": list(self.order_context.verified_numbers),
            },
            "last_tool_result": dict(self.last_tool_result),
            "last_response": self.last_response,
            "turn_id": self.turn_id,
            "interrupt_flag": self.interrupt_flag,
            "history_len": len(self.history),
            "turn_history_len": len(self.turn_history),
            "tool_history_len": len(self.tool_history),
        }

    def apply_patches(self, patches: dict[str, Any]) -> None:
        if not patches:
            return
        if "conversation_stage" in patches:
            self.conversation_stage = str(patches["conversation_stage"])
        if "cart" in patches:
            self.cart = list(patches["cart"])
        if "email" in patches and isinstance(patches["email"], dict):
            e = patches["email"]
            if "pending" in e:
                self.email.pending = str(e["pending"] or "")
            if "confirmed" in e:
                self.email.confirmed = str(e["confirmed"] or "")
            if "awaiting_confirmation" in e:
                self.email.awaiting_confirmation = bool(e["awaiting_confirmation"])
        if "order_context" in patches and isinstance(patches["order_context"], dict):
            o = patches["order_context"]
            if "last_number" in o:
                self.order_context.last_number = str(o["last_number"] or "")
            if "last_lookup" in o:
                self.order_context.last_lookup = dict(o["last_lookup"] or {})
            if "verified_numbers" in o:
                self.order_context.verified_numbers = list(o["verified_numbers"] or [])
        if "last_tool_result" in patches:
            self.last_tool_result = dict(patches["last_tool_result"] or {})
        if "last_response" in patches:
            self.last_response = str(patches["last_response"] or "")
        if "interrupt_flag" in patches:
            self.interrupt_flag = bool(patches["interrupt_flag"])
        if "metadata" in patches and isinstance(patches["metadata"], dict):
            self.metadata.update(patches["metadata"])


def _redis_key(call_sid: str) -> str:
    return f"{_KEY_PREFIX}{call_sid}"


def _serialize(state: V2SessionState) -> dict[str, Any]:
    return {
        "call_sid": state.call_sid,
        "from_number": state.from_number,
        "to_number": state.to_number,
        "session_id": state.session_id,
        "conversation_stage": state.conversation_stage,
        "cart": state.cart,
        "email": asdict(state.email),
        "order_context": asdict(state.order_context),
        "last_tool_result": state.last_tool_result,
        "last_response": state.last_response,
        "turn_id": state.turn_id,
        "interrupt_flag": state.interrupt_flag,
        "history": state.history,
        "metadata": state.metadata,
        "turn_history": state.turn_history,
        "tool_history": state.tool_history,
        "state_transitions": state.state_transitions,
    }


def _deserialize(data: dict[str, Any]) -> V2SessionState:
    email_raw = data.get("email") or {}
    order_raw = data.get("order_context") or {}
    return V2SessionState(
        call_sid=str(data.get("call_sid", "")),
        from_number=str(data.get("from_number", "")),
        to_number=str(data.get("to_number", "")),
        session_id=str(data.get("session_id", "")),
        conversation_stage=str(data.get("conversation_stage", "idle")),
        cart=list(data.get("cart") or []),
        email=EmailState(
            pending=str(email_raw.get("pending", "")),
            confirmed=str(email_raw.get("confirmed", "")),
            awaiting_confirmation=bool(email_raw.get("awaiting_confirmation")),
        ),
        order_context=OrderContext(
            last_number=str(order_raw.get("last_number", "")),
            last_lookup=dict(order_raw.get("last_lookup") or {}),
            verified_numbers=list(order_raw.get("verified_numbers") or []),
        ),
        last_tool_result=dict(data.get("last_tool_result") or {}),
        last_response=str(data.get("last_response", "")),
        turn_id=int(data.get("turn_id") or 0),
        interrupt_flag=bool(data.get("interrupt_flag")),
        history=list(data.get("history") or []),
        metadata=dict(data.get("metadata") or {}),
        turn_history=list(data.get("turn_history") or []),
        tool_history=list(data.get("tool_history") or []),
        state_transitions=list(data.get("state_transitions") or []),
    )


async def load_v2_session(call_sid: str) -> Optional[V2SessionState]:
    from ..state.session_store import cache_get

    raw = await cache_get(_redis_key(call_sid))
    if not raw:
        return None
    if isinstance(raw, str):
        raw = json.loads(raw)
    return _deserialize(raw)


async def save_v2_session(state: V2SessionState, ttl: int = _DEFAULT_TTL) -> None:
    from ..state.session_store import cache_set

    await cache_set(_redis_key(state.call_sid), _serialize(state), ttl=ttl)


async def get_or_create_v2_session(
    *,
    call_sid: str,
    from_number: str = "",
    to_number: str = "",
    session_id: str = "",
) -> V2SessionState:
    existing = await load_v2_session(call_sid)
    if existing is not None:
        return existing
    state = V2SessionState(
        call_sid=call_sid,
        from_number=from_number,
        to_number=to_number,
        session_id=session_id,
    )
    await save_v2_session(state)
    return state


async def set_interrupt_flag(call_sid: str, value: bool = True) -> None:
    """Interrupt model: flag only — no task cancel, no history rollback."""
    state = await load_v2_session(call_sid)
    if state is None:
        return
    state.interrupt_flag = value
    await save_v2_session(state)
    logger.info("v2_interrupt_flag sid=%s value=%s", call_sid[:6], value)


async def delete_v2_session(call_sid: str) -> None:
    from ..state.session_store import cache_delete

    await cache_delete(_redis_key(call_sid))
