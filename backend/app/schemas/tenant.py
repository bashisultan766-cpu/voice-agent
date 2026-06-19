from __future__ import annotations
from datetime import datetime
from pydantic import BaseModel, EmailStr, Field


class TenantCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=255)
    email: EmailStr
    password: str = Field(..., min_length=8)


class TenantLogin(BaseModel):
    email: EmailStr
    password: str


class TenantResponse(BaseModel):
    id: str
    name: str
    email: str
    api_key: str
    plan: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    tenant: TenantResponse
