"""
Quarantine marker for the legacy (pre-v4.18) runtime.

The modules listed in ``QUARANTINED_MODULES`` implemented the old architecture
that answered the caller *before* the LLM could reason: regex fast paths,
deterministic business-intent resolvers, JSON-only intent classifiers, canned
template composers, and multiple competing runtime routing modes.

They are NOT deleted (the existing unit-test suite imports many of them as
isolated units), but they are **route-disabled**: the live WebSocket turn path
(`ws.conversation_relay.dispatch_assembled_turn`) now routes every assembled
caller turn to the single LLM-first runtime
(`agent_runtime.llm_tool_runtime.LLMToolRuntime`). None of the modules below can
run in the customer response path.

If you are adding new caller-facing behaviour, add it to the LLM-first runtime or
expose it as a tool in ``agent_runtime.llm_tools`` — do not revive these.
"""

# Modules whose decision/answer logic is no longer in the customer path.
QUARANTINED_MODULES: tuple[str, ...] = (
    "agent_runtime.llm_first_runtime",
    "agent_runtime.runtime",  # EricAgentRuntime legacy handle_turn variants
    "agent_runtime.sales_flow",
    "agent_runtime.business_intent_resolver",
    "agent_runtime.main_llm_agent",
    "agent_runtime.brain_orchestrator",
    "agent_runtime.followup_context_resolver",
    "agent_runtime.commerce_commit_resolver",
    "agent_runtime.tool_answer_composer",
    "agent_runtime.final_response_composer",
    "agent_runtime.direct_llm_answerer",
    "agent_runtime.llm_supervisor",
    "agent_runtime.action_gate",
    "agent_runtime.tool_eligibility_gate",
    "agent_runtime.tool_plan_executor",
    "agent_runtime.speculative_prefetch_manager",
    "agent_runtime.brain_prefetch_arbitrator",
    "agent_runtime.intent_result_builder",
    "agent_runtime.tool_category_mapper",
    "composer.main_llm_composer",
    "pipeline.engine",
    "pipeline.compound_intent",
    "pipeline.router",
    "dialogue.short_utterance_resolver",
)

ACTIVE_RUNTIME = "agent_runtime.llm_tool_runtime"
