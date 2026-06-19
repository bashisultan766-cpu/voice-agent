# Compatibility shim. The canonical registry now lives in app/tools/registry.py.
from ...tools.registry import ToolRegistry, registry  # noqa: F401

__all__ = ["ToolRegistry", "registry"]
