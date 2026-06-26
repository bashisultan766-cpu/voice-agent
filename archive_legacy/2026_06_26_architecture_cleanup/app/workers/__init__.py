"""
Worker layer — deterministic async data-fetchers.

RULE: No worker in this package may import openai or call run_agent_turn.
Only app.composer.main_llm_composer is allowed to call OpenAI.
"""
