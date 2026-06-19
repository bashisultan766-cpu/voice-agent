from __future__ import annotations
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.api.deps import get_current_tenant
from app.models.call_log import CallLog
from app.models.tenant import Tenant
from app.schemas.call_log import CallLogResponse

router = APIRouter()


@router.get("/", response_model=List[CallLogResponse])
async def list_calls(
    agent_id: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    tenant: Tenant = Depends(get_current_tenant),
    db: AsyncSession = Depends(get_db),
):
    q = (
        select(CallLog)
        .options(selectinload(CallLog.turns))
        .where(CallLog.tenant_id == tenant.id)
        .order_by(CallLog.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if agent_id:
        q = q.where(CallLog.agent_id == agent_id)

    result = await db.execute(q)
    return [CallLogResponse.model_validate(c) for c in result.scalars().all()]


@router.get("/{call_id}", response_model=CallLogResponse)
async def get_call(
    call_id: str,
    tenant: Tenant = Depends(get_current_tenant),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(CallLog)
        .options(selectinload(CallLog.turns))
        .where(CallLog.id == call_id, CallLog.tenant_id == tenant.id)
    )
    call = result.scalar_one_or_none()
    if not call:
        raise HTTPException(status_code=404, detail="Call log not found")
    return CallLogResponse.model_validate(call)
