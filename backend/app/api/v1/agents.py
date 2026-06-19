from __future__ import annotations
import uuid
from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.api.deps import get_current_tenant
from app.models.agent import Agent
from app.models.tenant import Tenant
from app.schemas.agent import AgentCreate, AgentUpdate, AgentResponse
from app.core.encryption import encrypt, decrypt
from app.integrations.shopify import get_shopify_client

router = APIRouter()


def _apply_create(agent: Agent, payload: AgentCreate) -> None:
    if payload.shopify_api_key:
        agent.shopify_api_key_enc = encrypt(payload.shopify_api_key)
    if payload.openai_api_key:
        agent.openai_api_key_enc = encrypt(payload.openai_api_key)
    if payload.resend_api_key:
        agent.resend_api_key_enc = encrypt(payload.resend_api_key)


def _apply_update(agent: Agent, payload: AgentUpdate) -> None:
    for field in [
        "name", "description", "shopify_store_url", "llm_provider", "llm_model",
        "tts_provider", "voice_id", "system_prompt", "twilio_phone_number",
        "enabled_tools", "from_email", "is_active",
    ]:
        v = getattr(payload, field, None)
        if v is not None:
            setattr(agent, field, v)

    if payload.shopify_api_key is not None:
        agent.shopify_api_key_enc = encrypt(payload.shopify_api_key) if payload.shopify_api_key else None
    if payload.openai_api_key is not None:
        agent.openai_api_key_enc = encrypt(payload.openai_api_key) if payload.openai_api_key else None
    if payload.resend_api_key is not None:
        agent.resend_api_key_enc = encrypt(payload.resend_api_key) if payload.resend_api_key else None


@router.get("/", response_model=List[AgentResponse])
async def list_agents(
    tenant: Tenant = Depends(get_current_tenant),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Agent).where(Agent.tenant_id == tenant.id).order_by(Agent.created_at.desc())
    )
    return [AgentResponse.model_validate(a) for a in result.scalars().all()]


@router.post("/", response_model=AgentResponse, status_code=status.HTTP_201_CREATED)
async def create_agent(
    payload: AgentCreate,
    tenant: Tenant = Depends(get_current_tenant),
    db: AsyncSession = Depends(get_db),
):
    agent = Agent(
        id=str(uuid.uuid4()),
        tenant_id=tenant.id,
        name=payload.name,
        description=payload.description,
        shopify_store_url=payload.shopify_store_url,
        llm_provider=payload.llm_provider,
        llm_model=payload.llm_model,
        tts_provider=payload.tts_provider,
        voice_id=payload.voice_id,
        system_prompt=payload.system_prompt or Agent.system_prompt.default,
        twilio_phone_number=payload.twilio_phone_number,
        enabled_tools=payload.enabled_tools,
        from_email=payload.from_email,
    )
    _apply_create(agent, payload)
    db.add(agent)
    await db.commit()
    await db.refresh(agent)
    return AgentResponse.model_validate(agent)


@router.get("/{agent_id}", response_model=AgentResponse)
async def get_agent(
    agent_id: str,
    tenant: Tenant = Depends(get_current_tenant),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.tenant_id == tenant.id)
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return AgentResponse.model_validate(agent)


@router.patch("/{agent_id}", response_model=AgentResponse)
async def update_agent(
    agent_id: str,
    payload: AgentUpdate,
    tenant: Tenant = Depends(get_current_tenant),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.tenant_id == tenant.id)
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    _apply_update(agent, payload)
    await db.commit()
    await db.refresh(agent)
    return AgentResponse.model_validate(agent)


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent(
    agent_id: str,
    tenant: Tenant = Depends(get_current_tenant),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.tenant_id == tenant.id)
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    await db.delete(agent)
    await db.commit()


@router.post("/{agent_id}/test-shopify")
async def test_shopify_connection(
    agent_id: str,
    tenant: Tenant = Depends(get_current_tenant),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.tenant_id == tenant.id)
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    if not agent.shopify_store_url or not agent.shopify_api_key_enc:
        return {"success": False, "error": "Shopify credentials not configured"}

    try:
        token = decrypt(agent.shopify_api_key_enc)
        client = get_shopify_client(agent.shopify_store_url, token)
        products = await client.search_products("a", limit=1)
        return {"success": True, "products_found": len(products)}
    except Exception as e:
        return {"success": False, "error": str(e)}
