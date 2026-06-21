from __future__ import annotations
import logging
from typing import Any, Dict, Optional

from app.tools.base import ToolContext
from app.tools.registry import ToolRegistry
from app.voice.orchestrator import OrchestratorResult, ParallelVoiceOrchestrator

logger = logging.getLogger("voice.pipeline")


class VoicePipeline:
    """
    Thin coordinator for voice turns.

    Delegates all parallel execution, latency budgeting, and fallback handling
    to ParallelVoiceOrchestrator. This class exists for backward compatibility
    with the legacy VoicePipeline interface used by Twilio webhooks.
    """

    def __init__(
        self,
        agent_id: str,
        tenant_id: str,
        call_sid: str,
        system_prompt: str,
        tool_registry: ToolRegistry,
        tool_context: ToolContext,
        llm_model: str = "gpt-4o-mini",
        tts_voice: str = "alloy",
        openai_api_key: Optional[str] = None,
        use_openai_tts: bool = True,
    ) -> None:
        self._orchestrator = ParallelVoiceOrchestrator(
            agent_id=agent_id,
            tenant_id=tenant_id,
            call_sid=call_sid,
            system_prompt=system_prompt,
            tool_registry=tool_registry,
            tool_context=tool_context,
            llm_model=llm_model,
            tts_voice=tts_voice,
            openai_api_key=openai_api_key,
            use_openai_tts=use_openai_tts,
        )

    async def process_turn(self, transcript: str) -> Dict[str, Any]:
        """
        Process a user speech turn. Returns a plain dict for Twilio compatibility.
        """
        logger.info(
            "pipeline_delegate_turn",
            extra={"call_sid": self._orchestrator.call_sid, "transcript_len": len(transcript)},
        )
        result: OrchestratorResult = await self._orchestrator.process_turn(transcript)
        return result.to_dict()
