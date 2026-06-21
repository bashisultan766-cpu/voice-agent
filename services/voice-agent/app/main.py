from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .core.env_validation import validate_startup_env
from .api.health import router as health_router
from .api.voice import router as voice_router
from .ws.media_stream import handle_media_stream


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    validate_startup_env(settings)
    Path(settings.AUDIO_CACHE_DIR).mkdir(parents=True, exist_ok=True)
    yield


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="Voice Agent",
        version="0.1.0",
        docs_url="/docs",
        redoc_url=None,
        lifespan=lifespan,
    )

    @app.get("/", tags=["health"])
    async def root() -> dict[str, str]:
        return {
            "service": "voice-agent",
            "status": "ok",
            "docs": "/docs",
            "health": "/health",
        }

    # Serve cached TTS audio files so Twilio can fetch them
    Path(settings.AUDIO_CACHE_DIR).mkdir(parents=True, exist_ok=True)
    app.mount(
        "/audio",
        StaticFiles(directory=settings.AUDIO_CACHE_DIR),
        name="audio",
    )

    app.include_router(health_router)
    app.include_router(voice_router)

    @app.websocket("/ws/stream")
    async def media_stream_endpoint(websocket: WebSocket):
        await handle_media_stream(websocket)

    return app


app = create_app()
