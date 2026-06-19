"""
OpenAI streaming LLM + tool-call orchestration.

TODO (Milestone 3 — WebSocket pipeline):
    Implement the streaming LLM layer here.

Responsibilities:
    - Accept a user utterance + session history + tool schemas.
    - Stream tokens from OpenAI chat.completions (stream=True).
    - Buffer tokens into sentences; yield each sentence as it completes
      so pipeline/tts.py can start synthesizing before the full response is done.
    - Detect tool_call deltas; accumulate function arguments; dispatch tools.
    - Apply per-call token budget (Settings.MAX_TOKENS_PER_CALL).
    - Escalate to Settings.LLM_ESCALATION_MODEL when a complex tool chain
      is detected (heuristic: >2 tool calls in one turn).

Sentence boundary detection (simple, voice-optimised):
    Split on '. ', '! ', '? ' followed by a capital letter.
    Yield each sentence immediately after its final punctuation arrives.

Cost tracking:
    Feed prompt_tokens + completion_tokens to core/logging.CallCostTracker
    after each completion.

Tool dispatch:
    Reuse _execute_tool() from app/ai/tool_loop.py or extract it here.
    Tool results are fed back as tool messages in the next iteration.
"""
from __future__ import annotations
