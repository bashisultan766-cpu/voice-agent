import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import get_settings
from .logging_config import configure_logging
from .api.health import router as health_router
from .sync.webhooks import webhooks_router, admin_router
from .api.admin_debug import admin_debug_router
from .api.admin_analytics import admin_analytics_router

_log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.LOG_LEVEL)
    settings.validate_production()
    from .state.session_store import verify_redis_at_startup

    await verify_redis_at_startup()
    from .db.connection import verify_postgres_at_startup

    await verify_postgres_at_startup()
    from .agent_runtime.workflow_compiler import compile_workflows_at_startup

    compile_workflows_at_startup()
    from app.agent_os.dsl.workflow_dsl import export_workflow_dsl

    export_workflow_dsl(validate=True)
    # Prove OpenAI configuration at startup (no secrets logged).
    from .agent_runtime.openai_health import log_startup_health
    from .agent_runtime.live_runtime import resolve_live_turn_handler
    from .voice_os_v2.runtime import voice_os_v2_enabled

    log_startup_health(settings)
    from .agent_runtime import llm_tools
    from .agent_runtime.master_prompt import prompt_startup_diagnostic
    from .agent_runtime.runtime_identity import collect_runtime_identity, validate_runtime_identity

    identity = collect_runtime_identity()
    identity_failures = validate_runtime_identity(identity)

    prompt_diag = prompt_startup_diagnostic()
    _log.info(
        "runtime_identity cwd=%s app_main=%s release_path=%s python=%s pm2_name=%s "
        "git_commit=%s git_branch=%s git_status_clean=%s",
        identity.get("process_cwd"),
        identity.get("app_main_file"),
        identity.get("active_release_path"),
        identity.get("python_executable"),
        identity.get("pm2_process_name"),
        identity.get("git_commit"),
        identity.get("git_branch"),
        identity.get("git_status_clean"),
    )
    _log.info(
        "master_prompt_path=%s master_prompt_chars=%d master_prompt_sections=%d",
        identity.get("master_prompt_path"),
        identity.get("master_prompt_chars"),
        identity.get("master_prompt_sections"),
    )
    _log.info(
        "voice_sales_flow_version=%s tool_progress_prompts_enabled=%s "
        "payment_email_state_version=%s email_capture_short_circuit_enabled=%s "
        "payment_auto_send_enabled=%s create_checkout_customer_facing=%s "
        "send_payment_link_customer_facing=%s create_checkout_present_in_tool_specs=%s",
        identity.get("voice_sales_flow_version"),
        identity.get("tool_progress_prompts_enabled"),
        identity.get("payment_email_state_version"),
        identity.get("email_capture_short_circuit_enabled"),
        identity.get("payment_auto_send_enabled"),
        identity.get("create_checkout_customer_facing"),
        identity.get("send_payment_link_customer_facing"),
        identity.get("create_checkout_present_in_tool_specs"),
    )
    if identity_failures:
        _log.error(
            "runtime_identity_check_failed failures=%s — PM2 may be serving stale code",
            ",".join(identity_failures),
        )
    else:
        _log.info("runtime_identity_check_passed=true")
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
        "voice_runtime=%s active_turn_handler=%s voice_os_v2=%s "
        "customer_facing_tools=%d openai_model=%s "
        "llm_only_final_output=%s",
        settings.VOICE_RUNTIME,
        resolve_live_turn_handler(settings),
        voice_os_v2_enabled(settings),
        len(llm_tools.customer_facing_tool_names()),
        settings.OPENAI_MODEL,
        settings.VOICE_LLM_ONLY_FINAL_OUTPUT,
    )
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    docs_url = "/docs" if settings.api_docs_enabled else None
    openapi_url = "/openapi.json" if settings.api_docs_enabled else None

    app = FastAPI(
        title="Twilio Voice Agent — ConversationRelay Runtime",
        version="1.0.0",
        docs_url=docs_url,
        redoc_url=None,
        openapi_url=openapi_url,
        lifespan=lifespan,
    )

    app.include_router(health_router)
    app.include_router(webhooks_router)
    app.include_router(admin_router)
    app.include_router(admin_debug_router)
    app.include_router(admin_analytics_router)

    return app


app = create_app()
