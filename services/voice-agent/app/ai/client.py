from typing import Optional

from openai import AsyncOpenAI

from ..config import get_settings

_clients: dict[str, AsyncOpenAI] = {}


def get_openai_client(api_key: Optional[str] = None) -> AsyncOpenAI:
    """
    Return a cached AsyncOpenAI client.
    Per-agent api_key overrides the global key.
    """
    settings = get_settings()
    key = api_key or settings.OPENAI_API_KEY

    if key not in _clients:
        _clients[key] = AsyncOpenAI(api_key=key)

    return _clients[key]
