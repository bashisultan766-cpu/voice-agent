"""Eric Agent Runtime (v4.14) — n8n-style LLM agent core."""
from .eric_master_policy import (
    ERIC_BUSINESS_RULES,
    ERIC_CLIENT_RULES,
    ERIC_DOMAIN_BOUNDARIES,
    ERIC_MASTER_SYSTEM_PROMPT,
    ERIC_PRIVACY_RULES,
    ERIC_RESPONSE_STYLE,
    ERIC_TOOL_POLICY_SUMMARY,
    build_eric_brain_system_prompt,
    build_eric_final_response_system_prompt,
    block_processing_fee,
    sanitize_policy_leak,
)
from .runtime import (
    EricAgentRuntime,
    get_eric_runtime,
    is_eric_runtime_mode,
    is_main_llm_agent_mode,
)
from .llm_supervisor import LLMSupervisor, get_supervisor
from .main_llm_agent import MainLLMAgent, decide_and_answer
from .types import SupervisorDecision, RuntimeTurnResult, StatePacket

__all__ = [
    "ERIC_MASTER_SYSTEM_PROMPT",
    "ERIC_DOMAIN_BOUNDARIES",
    "ERIC_BUSINESS_RULES",
    "ERIC_RESPONSE_STYLE",
    "ERIC_PRIVACY_RULES",
    "ERIC_TOOL_POLICY_SUMMARY",
    "ERIC_CLIENT_RULES",
    "build_eric_brain_system_prompt",
    "build_eric_final_response_system_prompt",
    "block_processing_fee",
    "sanitize_policy_leak",
    "EricAgentRuntime",
    "get_eric_runtime",
    "is_eric_runtime_mode",
    "is_main_llm_agent_mode",
    "LLMSupervisor",
    "get_supervisor",
    "MainLLMAgent",
    "decide_and_answer",
    "SupervisorDecision",
    "RuntimeTurnResult",
    "StatePacket",
]
