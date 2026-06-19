from __future__ import annotations
from datetime import datetime
from typing import Any, List, Optional
from pydantic import BaseModel


class ConversationTurnResponse(BaseModel):
    id: str
    role: str
    content: str
    tool_calls: Optional[List[Any]] = None
    tool_results: Optional[List[Any]] = None
    latency_ms: Optional[int] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class CallLogResponse(BaseModel):
    id: str
    agent_id: Optional[str]
    tenant_id: str
    call_sid: Optional[str]
    from_number: Optional[str]
    to_number: Optional[str]
    status: str
    duration_seconds: Optional[int]
    started_at: Optional[datetime]
    ended_at: Optional[datetime]
    created_at: datetime
    turns: List[ConversationTurnResponse] = []

    model_config = {"from_attributes": True}
