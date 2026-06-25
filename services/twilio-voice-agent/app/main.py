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
    from .payment.email_state import (
        CREATE_CHECKOUT_CUSTOMER_FACING,
        EMAIL_CAPTURE_SHORT_CIRCUIT_ENABLED,
        PAYMENT_AUTO_SEND_ENABLED,
        PAYMENT_EMAIL_STATE_VERSION,
        SEND_PAYMENT_LINK_CUSTOMER_FACING,
    )
    from .agent_runtime.commerce_flow_state import COMMERCE_FLOW_VERSION
    from .agent_runtime.tool_progress import TOOL_PROGRESS_ENABLED

    def _git_commit_short() -> str:
        import subprocess

        try:
            return subprocess.check_output(
                ["git", "rev-parse", "--short", "HEAD"],
                stderr=subprocess.DEVNULL,
                text=True,
            ).strip()
        except Exception:  # noqa: BLE001
            return "unknown"

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
        "llm_tool_runtime_tools=%d customer_facing_tools=%d",
        settings.VOICE_RUNTIME,
        settings.VOICE_AGENT_RUNTIME_MODE,
        resolve_live_turn_handler(settings),
        len(llm_tools.tool_names()),
        len(llm_tools.customer_facing_tool_names()),
    )
    _log.info(
        "payment_email_state_version=%s email_capture_short_circuit_enabled=%s "
        "payment_auto_send_enabled=%s create_checkout_customer_facing=%s "
        "send_payment_link_customer_facing=%s commerce_flow_version=%s "
        "tool_progress_enabled=%s git_commit=%s",
        PAYMENT_EMAIL_STATE_VERSION,
        EMAIL_CAPTURE_SHORT_CIRCUIT_ENABLED,
        PAYMENT_AUTO_SEND_ENABLED,
        CREATE_CHECKOUT_CUSTOMER_FACING,
        SEND_PAYMENT_LINK_CUSTOMER_FACING,
        COMMERCE_FLOW_VERSION,
        TOOL_PROGRESS_ENABLED,
        _git_commit_short(),
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
