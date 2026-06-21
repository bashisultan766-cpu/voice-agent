"""
Minimal pytest configuration for the backend tests.

Sets required env vars so pydantic-settings can construct `Settings`
without a real .env file.
"""
import os

# Must be set before any app module is imported.
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")
os.environ.setdefault("REDIS_URL", "redis://127.0.0.1:6379")
os.environ.setdefault("ENCRYPTION_KEY", "a" * 64)
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("PUBLIC_WEBHOOK_BASE_URL", "https://test.example.com")
