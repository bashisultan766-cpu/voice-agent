from __future__ import annotations
import asyncio
import json
import time
from typing import Any, Dict, List, Optional
from app.config import settings
from app.core.cache import cache_get, cache_set
from app.tools.base import ToolContext
from app.tools.registry import ToolRegistry
from app.voice.llm import run_agentic_loop
from app.voice.tts import synthesize_speech, truncate_for_voice


# Instant-reply bypass — no LLM needed
INSTANT_REPLIES: Dict[str, str] = {
    "hello": "Hi there! How can I help you today?",
    "hi": "Hi! How can I help you today?",
    "hey": "Hey! How can I help you?",
    "thank you": "You're welcome! Is there anything else I can help you with?",
    "thanks": "You're welcome! Anything else?",
    "goodbye": "Goodbye! Have a great day!",
    "bye": "Goodbye! Have a great day!",
    "no": "Alright, is there anything else I can help you with?",
    "yes": "Great! What would you like to do?",
}


class VoicePipeline:
    """
    Core voice pipeline: transcript → LLM + tools → TTS → TwiML response.
    Designed for <20s end-to-end latency.
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
    ):
        self.agent_id = agent_id
        self.tenant_id = tenant_id
        self.call_sid = call_sid
        self.system_prompt = system_prompt
        self.tool_registry = tool_registry
        self.tool_context = tool_context
        self.llm_model = llm_model
        self.tts_voice = tts_voice
        self.openai_api_key = openai_api_key
        self.use_openai_tts = use_openai_tts

    # ── Conversation history ──────────────────────────────────────────────────

    def _history_key(self) -> str:
        return f"conv:history:{self.call_sid}"

    async def _load_history(self) -> List[Dict[str, Any]]:
        return (await cache_get(self._history_key())) or []

    async def _save_history(self, history: List[Dict[str, Any]]) -> None:
        await cache_set(self._history_key(), history, ttl=3600)

    async def _append_turn(self, role: str, content: str) -> None:
        history = await self._load_history()
        history.append({"role": role, "content": content})
        if len(history) > 40:  # keep last 20 exchanges
            history = history[-40:]
        await self._save_history(history)

    # ── Instant reply ─────────────────────────────────────────────────────────

    def _instant_reply(self, transcript: str) -> Optional[str]:
        normalized = transcript.strip().lower().rstrip(".,!?")
        return INSTANT_REPLIES.get(normalized)

    # ── Tool executor ─────────────────────────────────────────────────────────

    async def _execute_tool(self, name: str, args: Dict[str, Any]) -> str:
        return await self.tool_registry.execute(name, self.tool_context, args)

    # ── Main process turn ─────────────────────────────────────────────────────

    async def process_turn(self, transcript: str) -> Dict[str, Any]:
        """
        Process a user speech turn. Returns:
        {
            "text": str,           # LLM response text
            "audio_path": str|None, # TTS audio file path (if generated)
            "latency_ms": int,
            "tool_calls": list,
        }
        """
        start = time.monotonic()

        # 1. Instant reply bypass
        instant = self._instant_reply(transcript)
        if instant:
            await self._append_turn("user", transcript)
            await self._append_turn("assistant", instant)
            audio_path = await self._maybe_tts(instant)
            return {
                "text": instant,
                "audio_path": audio_path,
                "latency_ms": int((time.monotonic() - start) * 1000),
                "tool_calls": [],
            }

        # 2. Load history
        history = await self._load_history()

        # 3. Agentic LLM loop (with parallel tool execution)
        response_text, tool_calls = await run_agentic_loop(
            system_prompt=self.system_prompt,
            conversation_history=history,
            user_message=transcript,
            tool_schemas=self.tool_registry.schemas(),
            tool_executor=self._execute_tool,
            model=self.llm_model,
            api_key=self.openai_api_key,
            max_iterations=settings.MAX_TOOL_ITERATIONS,
        )

        # 4. Trim response for voice delivery
        voice_text = truncate_for_voice(response_text)

        # 5. Save turns to history
        await self._append_turn("user", transcript)
        await self._append_turn("assistant", response_text)

        # 6. Generate TTS in parallel with history save (already overlapped by step 5)
        audio_path = await self._maybe_tts(voice_text)

        latency_ms = int((time.monotonic() - start) * 1000)
        return {
            "text": voice_text,
            "audio_path": audio_path,
            "latency_ms": latency_ms,
            "tool_calls": tool_calls,
        }

    async def _maybe_tts(self, text: str) -> Optional[str]:
        if not self.use_openai_tts:
            return None
        try:
            return await asyncio.wait_for(
                synthesize_speech(
                    text,
                    voice=self.tts_voice,
                    api_key=self.openai_api_key,
                ),
                timeout=8.0,
            )
        except asyncio.TimeoutError:
            return None
