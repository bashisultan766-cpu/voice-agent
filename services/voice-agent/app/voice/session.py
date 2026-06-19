"""
Voice-layer session facade.
Thin wrapper over the state store exposing only the operations
the voice pipeline needs.
"""
from ..state.schema import ConversationState, EmailFSMState, SessionState
from ..state.store import SessionStore, get_session_store

__all__ = [
    "get_session_store",
    "SessionStore",
    "SessionState",
    "ConversationState",
    "EmailFSMState",
]
