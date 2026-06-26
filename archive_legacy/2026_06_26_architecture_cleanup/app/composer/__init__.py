"""
Composer layer.

RULE: MainLLMComposer is the ONLY component in this codebase allowed to call OpenAI.
Workers in app.workers must never import openai or call run_agent_turn.
"""
