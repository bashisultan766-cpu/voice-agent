from __future__ import annotations
import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models.tenant import Tenant
from app.schemas.tenant import TenantCreate, TenantLogin, TenantResponse, TokenResponse
from app.core.security import hash_password, verify_password, create_access_token

router = APIRouter()


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(payload: TenantCreate, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(select(Tenant).where(Tenant.email == payload.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already registered")

    tenant = Tenant(
        id=str(uuid.uuid4()),
        name=payload.name,
        email=payload.email,
        hashed_password=hash_password(payload.password),
        api_key=f"sk_{uuid.uuid4().hex}",
    )
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)

    token = create_access_token(tenant.id)
    return TokenResponse(access_token=token, tenant=TenantResponse.model_validate(tenant))


@router.post("/login", response_model=TokenResponse)
async def login(payload: TenantLogin, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Tenant).where(Tenant.email == payload.email))
    tenant = result.scalar_one_or_none()

    if not tenant or not verify_password(payload.password, tenant.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not tenant.is_active:
        raise HTTPException(status_code=403, detail="Account disabled")

    token = create_access_token(tenant.id)
    return TokenResponse(access_token=token, tenant=TenantResponse.model_validate(tenant))


@router.get("/me", response_model=TenantResponse)
async def me(db: AsyncSession = Depends(get_db), credentials=None):
    from app.api.deps import get_current_tenant
    # This is wired via dependency in router; re-export for direct use
    raise HTTPException(status_code=501, detail="Use GET /auth/me with Bearer token via deps")
