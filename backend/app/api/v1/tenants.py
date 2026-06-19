from __future__ import annotations
from fastapi import APIRouter, Depends
from app.api.deps import get_current_tenant
from app.models.tenant import Tenant
from app.schemas.tenant import TenantResponse

router = APIRouter()


@router.get("/me", response_model=TenantResponse)
async def get_me(tenant: Tenant = Depends(get_current_tenant)):
    return TenantResponse.model_validate(tenant)
