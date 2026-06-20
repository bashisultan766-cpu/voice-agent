"""
Tool: save_caller_name
Version: v2

Purpose:
    Persist the caller's name to their phone profile for future calls.
    success=True only when the name is confirmed saved.

    Two-layer architecture:
        MOCK: MockCallerNameStore  (active — in-memory dict, verifies persistence)
        REAL: RealCallerNameClient (disabled — POST {internal_api_url}/voice/save-caller-name)
"""
from __future__ import annotations

import logging
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from ..ai.common.validators import normalize_phone
from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

USE_REAL_CALLER_DB: bool = False

# Shared mock store — survives across calls within the process
_MOCK_CALLER_NAMES: dict[str, str] = {}


class SaveCallerNameData(BaseModel):
    phone_e164: str
    caller_name: str
    first_name: str
    saved: bool
    persisted: bool
    source: Literal["mock", "database"] = "mock"


class SaveCallerNameRequest(BaseModel):
    name: str = Field(..., description="Caller's full or first name")
    phone_number: Optional[str] = Field(
        None,
        description="Caller phone — defaults to the inbound call number",
    )

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        v = " ".join(v.strip().split())
        if not v:
            raise ValueError("name cannot be empty")
        if len(v) > 100:
            raise ValueError("name is too long")
        return v

    @field_validator("phone_number")
    @classmethod
    def clean_phone(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        normalised = normalize_phone(v.strip())
        if not normalised or len(normalised) < 8:
            raise ValueError(f"Cannot normalise phone number from {v!r}.")
        return normalised


def _extract_first_name(full_name: str) -> str:
    return full_name.split()[0] if full_name.split() else full_name


def _format_voice_summary(data: SaveCallerNameData) -> str:
    if data.saved and data.persisted:
        return (
            f"Got it — I've saved your name as {data.first_name}. "
            "I'll remember that for next time you call."
        )
    return (
        "I wasn't able to save your name right now. "
        "No worries — we can still continue with your request."
    )


class MockCallerNameStore:
    @staticmethod
    def save(phone_e164: str, name: str) -> SaveCallerNameData:
        first_name = _extract_first_name(name)
        _MOCK_CALLER_NAMES[phone_e164] = name
        persisted = _MOCK_CALLER_NAMES.get(phone_e164) == name
        logger.info(
            "[CALLER NAME STUB] phone=%s name=%r persisted=%s",
            phone_e164[:6] + "***",
            name,
            persisted,
        )
        return SaveCallerNameData(
            phone_e164=phone_e164,
            caller_name=name,
            first_name=first_name,
            saved=persisted,
            persisted=persisted,
            source="mock",
        )

    @staticmethod
    def get(phone_e164: str) -> Optional[str]:
        return _MOCK_CALLER_NAMES.get(phone_e164)


class RealCallerNameClient:
    """NOT YET IMPLEMENTED. POST {internal_api_url}/voice/save-caller-name"""

    def __init__(self, api_base: str, api_key: str) -> None:
        self._api_base = api_base
        self._api_key = api_key

    async def save(self, phone_e164: str, name: str) -> SaveCallerNameData:
        raise NotImplementedError(
            "RealCallerNameClient.save() is not yet implemented. "
            "Keep USE_REAL_CALLER_DB=False until ready."
        )


async def _resolve_save(
    phone_e164: str,
    name: str,
    api_base: Optional[str],
    api_key: Optional[str],
) -> SaveCallerNameData:
    use_real = USE_REAL_CALLER_DB and bool(api_base and api_key)

    if use_real:
        try:
            client = RealCallerNameClient(api_base, api_key)  # type: ignore[arg-type]
            return await client.save(phone_e164, name)
        except NotImplementedError:
            logger.warning("RealCallerNameClient not implemented — falling back to mock")
        except Exception as exc:
            logger.error("RealCallerNameClient.save() failed: %s — falling back to mock", exc)

    return MockCallerNameStore.save(phone_e164, name)


class SaveCallerNameTool(BaseTool):
    name = "save_caller_name"
    description = (
        "Save the caller's name to their phone profile for future calls. "
        "Call when the caller provides their name and it should be remembered. "
        "Returns saved=true only when persistence is confirmed."
    )
    parameters = {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Caller's full or first name as they stated it",
            },
            "phone_number": {
                "type": "string",
                "description": "Optional — defaults to the inbound call number",
            },
        },
        "required": ["name"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        try:
            req = SaveCallerNameRequest(**args)
        except Exception as exc:
            return self.error_result(
                voice_summary="I didn't catch your name. Could you repeat it for me?",
                error=f"Invalid input: {exc}",
            )

        phone = req.phone_number or context.from_number
        if not phone:
            return self.error_result(
                voice_summary="I need your phone number on file to save your name.",
                error="No phone number available",
            )

        normalised = normalize_phone(phone.strip())
        if not normalised:
            return self.error_result(
                voice_summary="I couldn't save your name with that phone number.",
                error=f"Invalid phone: {phone!r}",
            )

        try:
            api_base = getattr(context.agent_config, "internal_api_url", None)
            api_key = getattr(context.agent_config, "internal_api_key", None)
            result = await _resolve_save(normalised, req.name, api_base, api_key)
        except Exception as exc:
            logger.error(
                "save_caller_name failed: %s session=%s", exc, context.session_id, exc_info=True
            )
            return self.error_result(
                voice_summary="I ran into a problem saving your name.",
                error=f"Save failed: {exc}",
            )

        voice_summary = _format_voice_summary(result)

        logger.info(
            "save_caller_name: phone=%s name=%r saved=%s persisted=%s session=%s",
            normalised[:6] + "***",
            req.name,
            result.saved,
            result.persisted,
            context.session_id,
        )

        if not result.saved or not result.persisted:
            return ToolResult(
                success=False,
                data={
                    "success": False,
                    "message": "Caller name was not persisted.",
                    "suggested_response": voice_summary,
                    "data": result.model_dump(),
                    "error": "persisted is False",
                },
                voice_summary=voice_summary,
                error="persisted is False",
            )

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": f"Caller name saved for {normalised}.",
                "suggested_response": voice_summary,
                "data": result.model_dump(),
                "error": None,
            },
            voice_summary=voice_summary,
            state_update={"caller_name": result.first_name},
        )


registry.register(SaveCallerNameTool())
