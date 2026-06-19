"""
VoicePipeline — core turn orchestrator.

Flow per turn:
  session load → deterministic gate → email FSM →
  intent router → AI tool loop → TTS → TwiML response
"""
import logging
from typing import Any

from ..ai.client import get_openai_client
from ..ai.prompt_builder import build_system_prompt
from ..ai.tool_loop import run_tool_loop
from ..config import get_settings
from ..state.schema import ConversationState, EmailFSMState, SessionState
from ..state.store import get_session_store
from ..tenant.schema import AgentConfig
from ..tenant.loader import get_tenant_loader
from ..tts.cache import TTSCache
from ..tts.openai_tts import OpenAITTSProvider
from .deterministic import (
    check_deterministic,
    handle_email_collection,
    handle_email_confirmation,
)
from .router import Intent, route_by_llm, route_by_regex
from .twiml import gather_twiml, hangup_twiml

logger = logging.getLogger(__name__)

_TERMINAL_STATES = {ConversationState.ESCALATED, ConversationState.CLOSING}


class VoicePipeline:
    """
    Stateless orchestrator — all state lives in SessionStore.
    Create once at startup and reuse across requests.
    """

    def __init__(self) -> None:
        self._store = get_session_store()
        self._loader = get_tenant_loader()
        self._settings = get_settings()

    # ── Public entry points ────────────────────────────────────────────────────

    async def handle_incoming_call(
        self,
        call_sid: str,
        from_number: str,
        to_number: str,
    ) -> str:
        """Called once when a new inbound call arrives. Returns greeting TwiML."""
        config = await self._resolve_config(to_number=to_number)

        state = await self._store.create(
            session_id=call_sid,
            agent_id=config.agent_id,
            tenant_id=config.tenant_id,
            call_sid=call_sid,
            from_number=from_number,
            to_number=to_number,
        )
        logger.info(
            "Call started: sid=%s from=%s agent=%s",
            call_sid, from_number, config.agent_id,
        )

        greeting_url = await self._synthesize(config.resolve_greeting(), config)
        gather_url = self._gather_url(call_sid)
        return gather_twiml(
            action_url=gather_url,
            play_url=greeting_url,
            language=config.language,
        )

    async def handle_turn(
        self,
        session_id: str,
        speech_text: str,
        call_sid: str,
    ) -> str:
        """Called for each speech turn. Returns TwiML with the agent's audio response."""
        state = await self._load_or_recover_session(session_id, call_sid)
        config = await self._resolve_config(agent_id=state.agent_id)

        response_text = await self._process_turn(speech_text, state, config)

        audio_url = await self._synthesize(response_text, config)

        if state.conversation_state in _TERMINAL_STATES:
            return hangup_twiml(play_url=audio_url)

        return gather_twiml(
            action_url=self._gather_url(session_id),
            play_url=audio_url,
            language=state.language,
        )

    async def handle_call_ended(self, call_sid: str) -> None:
        await self._store.delete(call_sid)
        logger.info("Session cleaned up: sid=%s", call_sid)

    # ── Core turn logic ────────────────────────────────────────────────────────

    async def _process_turn(
        self,
        speech: str,
        state: SessionState,
        config: AgentConfig,
    ) -> str:
        # Gate 1: deterministic (post-payment, etc.)
        det = check_deterministic(speech, state, config)
        if det is not None:
            await self._store.save(state)
            return det

        # Gate 2: email FSM (zero LLM)
        if state.email_fsm_state == EmailFSMState.COLLECTING:
            return await handle_email_collection(speech, state, config, self._store)
        if state.email_fsm_state == EmailFSMState.CONFIRMING:
            return await handle_email_confirmation(speech, state, config, self._store)

        # Gate 3: fast exits via regex
        openai_client = get_openai_client(config.openai_api_key)
        decision = route_by_regex(speech)
        if decision.confidence < 0.80:
            decision = await route_by_llm(speech, openai_client)

        logger.debug(
            "Turn intent=%s conf=%.2f source=%s",
            decision.intent, decision.confidence, decision.source,
        )

        if decision.intent == Intent.GREETING:
            response = f"Hello! How can I help you today?"
            state.add_turn(speech, response)
            await self._store.save(state)
            return response

        if decision.intent == Intent.CLOSING:
            state.conversation_state = ConversationState.CLOSING
            response = "Thank you for calling. Have a wonderful day!"
            state.add_turn(speech, response)
            await self._store.save(state)
            return response

        # Gate 4: AI tool loop
        system_prompt = build_system_prompt(config, state)
        response_text, state_updates = await run_tool_loop(
            user_message=speech,
            system_prompt=system_prompt,
            agent_config=config,
            state=state,
            openai_client=openai_client,
        )

        self._apply_state_updates(state, state_updates)
        state.add_turn(speech, response_text)
        await self._store.save(state)

        return response_text

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _apply_state_updates(
        self,
        state: SessionState,
        updates: list[dict[str, Any]],
    ) -> None:
        for patch in updates:
            for key, value in patch.items():
                if not hasattr(state, key):
                    continue
                try:
                    if key == "conversation_state":
                        state.conversation_state = ConversationState(value)
                    elif key == "email_fsm_state":
                        state.email_fsm_state = EmailFSMState(value)
                    else:
                        setattr(state, key, value)
                except (ValueError, TypeError) as exc:
                    logger.warning("State update failed for %s=%r: %s", key, value, exc)

    async def _synthesize(self, text: str, config: AgentConfig) -> str:
        client = get_openai_client(config.openai_api_key)
        tts = TTSCache(OpenAITTSProvider(client))
        return await tts.get_or_synthesize(text, config.voice_id, config.voice_speed)

    async def _resolve_config(
        self,
        to_number: str | None = None,
        agent_id: str | None = None,
    ) -> AgentConfig:
        if agent_id:
            config = await self._loader.load_by_agent_id(agent_id)
        elif to_number:
            config = await self._loader.load_by_phone(to_number)
        else:
            config = None
        return config or await self._loader.load_default()

    async def _load_or_recover_session(
        self, session_id: str, call_sid: str
    ) -> SessionState:
        state = await self._store.get(session_id)
        if state is None:
            logger.warning("Session %s not found — recovering", session_id)
            state = await self._store.create(
                session_id=session_id,
                agent_id=self._settings.DEFAULT_AGENT_ID,
                tenant_id=self._settings.DEFAULT_TENANT_ID,
                call_sid=call_sid,
                from_number="unknown",
                to_number="unknown",
            )
        return state

    def _gather_url(self, session_id: str) -> str:
        return f"{self._settings.BASE_URL}/voice/gather?session={session_id}"
