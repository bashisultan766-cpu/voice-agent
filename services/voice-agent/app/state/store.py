import asyncio
from typing import Optional

from .schema import SessionState


class SessionStore:
    """
    In-memory session store for Phase 1.
    Phase 2: swap for Redis-backed implementation with TTL.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}
        self._lock = asyncio.Lock()

    async def get(self, session_id: str) -> Optional[SessionState]:
        return self._sessions.get(session_id)

    async def save(self, state: SessionState) -> None:
        async with self._lock:
            self._sessions[state.session_id] = state

    async def create(self, **kwargs) -> SessionState:
        state = SessionState(**kwargs)
        await self.save(state)
        return state

    async def delete(self, session_id: str) -> None:
        async with self._lock:
            self._sessions.pop(session_id, None)

    async def count(self) -> int:
        return len(self._sessions)


_store: Optional[SessionStore] = None


def get_session_store() -> SessionStore:
    global _store
    if _store is None:
        _store = SessionStore()
    return _store
