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
    from .agent_runtime.runtime import resolve_live_turn_handler

    log_startup_health(settings)
    from .agent_runtime import llm_tools
    from .agent_runtime.master_prompt import prompt_startup_diagnostic

    prompt_diag = prompt_startup_diagnostic()
    _log.info(
        "master_prompt_diag version=%s hash=%s chars=%d sections=%d approx_tokens=%d file=%s",
        prompt_diag["version"],
        prompt_diag["hash"],
        prompt_diag["chars"],
        prompt_diag["sections"],
        prompt_diag["approx_tokens"],
        prompt_diag["path"],
    )
    _log.info(
        "voice_runtime=%s voice_agent_runtime_mode=%s active_turn_handler=%s "
        "llm_tool_runtime_tools=%d",
        settings.VOICE_RUNTIME,
        settings.VOICE_AGENT_RUNTIME_MODE,
        resolve_live_turn_handler(settings),
        len(llm_tools.tool_names()),
    )
    if settings.VOICE_LIVE_DISABLE_OPENAI_TOOLS:
        _log.info(
            "legacy_openai_agent_tools_disabled=true "
            "(blocks run_agent_turn only; llm_tool_runtime OpenAI tools active=%s)",
            settings.VOICE_AGENT_RUNTIME_MODE == "llm_tool_runtime",
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
