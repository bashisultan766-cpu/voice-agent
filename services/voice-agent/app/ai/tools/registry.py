from typing import Optional

from .base import BaseTool


class ToolRegistry:
    """
    Plugin-based tool registry.
    Tools self-register by calling registry.register() at module import time.
    """

    def __init__(self) -> None:
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> "ToolRegistry":
        self._tools[tool.name] = tool
        return self

    def get(self, name: str) -> Optional[BaseTool]:
        return self._tools.get(name)

    def get_schemas(self, enabled_tools: list[str]) -> list[dict]:
        return [
            self._tools[name].to_openai_schema()
            for name in enabled_tools
            if name in self._tools
        ]

    def all_names(self) -> list[str]:
        return list(self._tools.keys())

    def __len__(self) -> int:
        return len(self._tools)


registry = ToolRegistry()
