from fastapi import APIRouter
from app.api.v1 import auth, agents, tenants, calls
from app.api.v1.webhooks import twilio as twilio_webhook

api_router = APIRouter()

api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(tenants.router, prefix="/tenants", tags=["tenants"])
api_router.include_router(agents.router, prefix="/agents", tags=["agents"])
api_router.include_router(calls.router, prefix="/calls", tags=["calls"])
api_router.include_router(twilio_webhook.router, prefix="/webhooks/twilio", tags=["webhooks"])
