"""
Deterministic turn handlers.
No LLM, no tool calls — pure regex + state logic.
These handle predictable conversation states with zero AI cost.
"""
import re
from typing import Optional, TYPE_CHECKING

from ..state.schema import EmailFSMState, SessionState

if TYPE_CHECKING:
    from ..tenant.schema import AgentConfig
    from ..state.store import SessionStore


# ── Patterns ──────────────────────────────────────────────────────────────────

_EMAIL_DIRECT_RE = re.compile(
    r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}", re.I
)
# "john dot doe at gmail dot com" or "john at gmail dot com"
_SPOKEN_EMAIL_RE = re.compile(
    r"(\S+)\s+(?:at|@)\s+(\S+)\s+dot\s+(\S+)", re.I
)
_YES_RE = re.compile(
    r"^(yes|yeah|yep|yup|correct|that'?s\s+right|that'?s\s+correct|confirmed?|right|"
    r"sounds\s+good|perfect|exactly)\b",
    re.I,
)
_NO_RE = re.compile(
    r"^(no|nope|nah|wrong|incorrect|that'?s\s+wrong|change\s+it|not\s+right)\b",
    re.I,
)
_POST_PAYMENT_RE = re.compile(
    r"\b(got\s+it|received|okay|ok|great|thank\s+you|thanks|perfect|"
    r"wonderful|sounds\s+good|alright|will\s+do)\b",
    re.I,
)


def _normalize_spoken_email(text: str) -> Optional[str]:
    """Convert spoken email formats to standard email address."""
    # Direct email in text
    m = _EMAIL_DIRECT_RE.search(text)
    if m:
        return re.sub(r"\s+", "", m.group(0))

    # "john at gmail dot com" → john@gmail.com
    m = _SPOKEN_EMAIL_RE.search(text)
    if m:
        local = re.sub(r"\s+dot\s+", ".", m.group(1), flags=re.I)
        domain = m.group(2)
        tld = m.group(3)
        return f"{local}@{domain}.{tld}"

    return None


def check_deterministic(
    speech: str,
    state: SessionState,
    agent_config: "AgentConfig",
) -> Optional[str]:
    """
    Returns a response string if the turn can be handled deterministically,
    or None to continue to the AI pipeline.
    """
    from ..state.schema import ConversationState

    # Post-payment acknowledgement → move to closing
    if state.conversation_state == ConversationState.CHECKOUT_SENT:
        if _POST_PAYMENT_RE.search(speech):
            state.conversation_state = ConversationState.CLOSING
            return agent_config.post_checkout_message.format(
                email=state.customer_email or "your email"
            )

    return None


async def handle_email_collection(
    speech: str,
    state: SessionState,
    agent_config: "AgentConfig",
    session_store: "SessionStore",
) -> str:
    """Handle turns when the email FSM is in COLLECTING state."""
    email = _normalize_spoken_email(speech)

    if not email:
        state.email_retry_count += 1
        await session_store.save(state)
        if state.email_retry_count >= 3:
            state.email_fsm_state = EmailFSMState.MAX_RETRIES
            await session_store.save(state)
            return (
                "I'm having trouble capturing your email address. "
                "Let me connect you with one of our team members."
            )
        return (
            "I didn't quite catch that. "
            "Could you spell out your email address? "
            "For example: john at gmail dot com."
        )

    state.email_pending_confirm = email
    state.email_fsm_state = EmailFSMState.CONFIRMING
    state.email_retry_count = 0
    await session_store.save(state)

    readable = email.replace("@", " at ").replace(".", " dot ")
    return f"Just to confirm, I have {readable}. Is that correct?"


async def handle_email_confirmation(
    speech: str,
    state: SessionState,
    agent_config: "AgentConfig",
    session_store: "SessionStore",
) -> str:
    """Handle turns when the email FSM is in CONFIRMING state."""
    if _YES_RE.match(speech.strip()):
        state.customer_email = state.email_pending_confirm
        state.email_fsm_state = EmailFSMState.CONFIRMED
        state.email_pending_confirm = None
        await session_store.save(state)
        return (
            "Perfect, I have your email confirmed. "
            "Give me just a moment to create your order."
        )

    if _NO_RE.match(speech.strip()):
        state.email_fsm_state = EmailFSMState.COLLECTING
        state.email_pending_confirm = None
        state.email_retry_count = 0
        await session_store.save(state)
        return "No problem. Please give me your email address again."

    # Ambiguous — re-prompt
    readable = (state.email_pending_confirm or "your email").replace("@", " at ").replace(".", " dot ")
    return f"I need a yes or no — is {readable} your correct email address?"
