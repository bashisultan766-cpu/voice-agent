import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket

from .config import get_settings
from .logging_config import configure_logging
from .api.health import router as health_router
from .api.twilio_voice import router as twilio_router
from .sync.webhooks import webhooks_router, admin_router
from .ws.conversation_relay import handle_conversation_relay

_log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.LOG_LEVEL)
    settings.validate_production()
    # Prove OpenAI configuration at startup (no secrets logged).
    from .agent_runtime.openai_health import log_startup_health

    log_startup_health(settings)
    if settings.VOICE_LIVE_DISABLE_OPENAI_TOOLS:
        _log.info(
            "live_openai_tools_disabled=true voice_runtime=%s",
            settings.VOICE_RUNTIME,
        )
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="Twilio Voice Agent — ConversationRelay Runtime",
        version="1.0.0",
        docs_url="/docs",
        redoc_url=None,
        lifespan=lifespan,
    )

    app.include_router(health_router)
    app.include_router(twilio_router)
    app.include_router(webhooks_router)
    app.include_router(admin_router)

    @app.websocket("/voice/twilio/ws")
    async def conversation_relay_ws(websocket: WebSocket) -> None:
        await handle_conversation_relay(websocket)

    return app


app = create_app()
