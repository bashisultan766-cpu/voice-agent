"""LLM summary of a voice call for backend support escalation."""
from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..state.models import SessionState

from ..agent_runtime.workflow_contracts import (
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_WORKFLOW,
    workflow_guard,
)

logger = logging.getLogger(__name__)

_SUMMARY_PROMPT = """You write internal support handoff notes for SureShot Books phone support.

Given the caller issue and conversation transcript, respond with JSON only (no markdown):
{
  "issue_summary": "one concise sentence describing the core problem",
  "user_intent": "short phrase for what the caller wants",
  "unresolved_needs": "what still requires human support action",
  "urgency_level": "low, medium, or high"
}

Rules:
- Base every field only on the transcript and issue context
- Do NOT invent order numbers, emails, or products not mentioned
- Do NOT include full credit card numbers
- urgency_level must be exactly low, medium, or high
"""


def build_conversation_transcript(
    session: "SessionState | None",
    *,
    caller_text: str = "",
    max_turns: int = 16,
) -> str:
    lines: list[str] = []
    history = list(getattr(session, "history", None) or [])[-max_turns:]
    for msg in history:
        role = str(msg.get("role") or "unknown").strip()
        content = str(msg.get("content") or "").strip()
        if content:
            lines.append(f"{role}: {content}")
    latest = (caller_text or "").strip()
    if latest and (not lines or not lines[-1].endswith(latest)):
        lines.append(f"user: {latest}")
    return "\n".join(lines)


def _fallback_summary(
    *,
    issue_title: str,
    issue_detail: str,
    transcript: str,
    customer_name: str,
) -> str:
    parts = []
    if customer_name:
        parts.append(f"Customer {customer_name} called SureShot Books.")
    parts.append(issue_title or "The customer has an unresolved request.")
    if issue_detail:
        parts.append(issue_detail)
    if transcript:
        parts.append("Recent conversation:")
        parts.append(transcript[-1500:])
    return " ".join(parts).strip()


def _fallback_analysis(
    *,
    issue_title: str,
    issue_detail: str,
    transcript: str,
    customer_name: str,
) -> dict[str, str]:
    summary = issue_title or "The customer has an unresolved request."
    if issue_detail:
        summary = f"{summary} {issue_detail}".strip()
    intent = "order_or_product_support"
    if re.search(r"\brefund\b", f"{issue_title} {issue_detail} {transcript}", re.I):
        intent = "refund_support"
    elif re.search(r"\b(cancel|cancellation)\b", f"{issue_title} {issue_detail} {transcript}", re.I):
        intent = "cancellation_support"
    elif re.search(r"\b(product|isbn|title|book|magazine|newspaper)\b", f"{issue_title} {issue_detail}", re.I):
        intent = "product_sourcing"
    unresolved = issue_detail or "Requires manual review and customer follow-up by email."
    urgency = "medium"
    if re.search(r"\b(urgent|asap|immediately|today)\b", transcript, re.I):
        urgency = "high"
    if customer_name:
        summary = f"{customer_name}: {summary}"
    return {
        "issue_summary": summary[:320],
        "user_intent": intent,
        "unresolved_needs": unresolved[:320],
        "urgency_level": urgency,
    }


def _parse_analysis_payload(raw: str) -> dict[str, str] | None:
    text = (raw or "").strip()
    if not text:
        return None
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            return None
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
    if not isinstance(data, dict):
        return None
    urgency = str(data.get("urgency_level") or "medium").strip().lower()
    if urgency not in ("low", "medium", "high"):
        urgency = "medium"
    return {
        "issue_summary": str(data.get("issue_summary") or "").strip()[:320],
        "user_intent": str(data.get("user_intent") or "").strip()[:160],
        "unresolved_needs": str(data.get("unresolved_needs") or "").strip()[:320],
        "urgency_level": urgency,
    }


@workflow_guard(SUPPORT_HANDOFF_WORKFLOW, "analyze_conversation_for_support")
async def analyze_conversation_for_support(
    session: "SessionState | None",
    *,
    caller_text: str = "",
    issue_title: str = "",
    issue_detail: str = "",
    api_context: dict[str, Any] | None = None,
) -> tuple[dict[str, str], str]:
    """Return structured conversation analysis and transcript."""
    transcript = build_conversation_transcript(session, caller_text=caller_text)
    customer_name = (getattr(session, "caller_name", "") or "").strip() if session else ""
    fallback = _fallback_analysis(
        issue_title=issue_title,
        issue_detail=issue_detail,
        transcript=transcript,
        customer_name=customer_name,
    )

    try:
        from ..config import get_settings

        settings = get_settings()
        if not getattr(settings, "OPENAI_API_KEY", ""):
            raise RuntimeError("no_openai_key")

        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        model = (
            getattr(settings, "OPENAI_FAST_MODEL", "")
            or getattr(settings, "OPENAI_MODEL", "gpt-4o-mini")
        )
        from ..agent_runtime.llm_sandbox import sanitize_support_llm_user_content

        user_content = sanitize_support_llm_user_content(
            issue_title=issue_title,
            issue_detail=issue_detail,
            customer_name=customer_name,
            transcript=transcript,
        )
        resp = await client.chat.completions.create(
            model=model,
            temperature=0.2,
            max_tokens=350,
            messages=[
                {"role": "system", "content": _SUMMARY_PROMPT},
                {"role": "user", "content": user_content},
            ],
        )
        parsed = _parse_analysis_payload(resp.choices[0].message.content or "")
        if parsed and parsed.get("issue_summary"):
            return parsed, transcript
    except Exception as exc:
        logger.warning("escalation_llm_analysis_failed err=%s", type(exc).__name__)

    return fallback, transcript


async def summarize_conversation_for_support(
    session: "SessionState | None",
    *,
    caller_text: str = "",
    issue_title: str = "",
    issue_detail: str = "",
    api_context: dict[str, Any] | None = None,
) -> tuple[str, str]:
    """
    Return (llm_summary, full_transcript).

    Falls back to a deterministic summary if the LLM is unavailable.
    """
    analysis, transcript = await analyze_conversation_for_support(
        session,
        caller_text=caller_text,
        issue_title=issue_title,
        issue_detail=issue_detail,
        api_context=api_context,
    )
    bullets = [
        f"- {analysis['issue_summary']}",
        f"- Intent: {analysis['user_intent']}",
        f"- Unresolved: {analysis['unresolved_needs']}",
        f"- Urgency: {analysis['urgency_level']}",
    ]
    return "\n".join(bullets), transcript
