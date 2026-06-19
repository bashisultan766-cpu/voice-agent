from fastapi import APIRouter
from pydantic import BaseModel

from ..state.store import get_session_store

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: str
    version: str
    active_sessions: int


@router.get("/health")
async def health() -> HealthResponse:
    store = get_session_store()
    return HealthResponse(
        status="ok",
        version="0.1.0",
        active_sessions=await store.count(),
    )
