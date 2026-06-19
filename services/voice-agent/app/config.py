# Backward-compatibility shim. Canonical config now lives in app/core/config.py.
# All existing imports (from ..config import get_settings) continue to work.
from .core.config import Settings, get_settings  # noqa: F401

__all__ = ["Settings", "get_settings"]
