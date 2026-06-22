"""v4.6 tests — voice config and health privacy."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")
os.environ.setdefault("ELEVENLABS_API_KEY", "secret-key-do-not-expose")

from fastapi.testclient import TestClient


def _client():
    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    return TestClient(create_app())


class TestVoiceConfigPrivacy:
    def test_health_no_api_key(self):
        client = _client()
        resp = client.get("/health")
        data = resp.json()
        assert "secret" not in str(data).lower()
        assert "ELEVENLABS" not in str(data)
        assert data["ok"] is True

    def test_env_example_has_placeholders(self):
        path = os.path.join(
            os.path.dirname(__file__), "..", "..", ".env.example",
        )
        with open(path, encoding="utf-8", errors="replace") as f:
            content = f.read()
        assert "VOICE_ID=your_elevenlabs_voice_id_here" in content
        assert "optional_for_future" in content.lower() or "do_not_commit" in content
