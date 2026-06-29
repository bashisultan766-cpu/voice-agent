"""LLM summary of a voice call for backend support escalation."""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_SUMMARY_PROMPT = """You write internal support handoff notes for SureShot Books phone support.

Given the caller issue and conversation transcript, write 3-5 short bullet points for the backend team:
- What the customer wants (order lookup, product, refund, etc.)
- Key facts mentioned (order numbers, ISBNs, titles, facility names)
- What the automated agent already tried and what failed
- What the backend team should do next

Rules:
- One line per bullet, start each line with "- "
- Professional tone, to the point — no greeting or sign-off
- Include customer name if known
- Do NOT invent order numbers, emails, or products not in the transcript
- Do NOT include full credit card numbers
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
    transcript = build_conversation_transcript(session, caller_text=caller_text)
    customer_name = (getattr(session, "caller_name", "") or "").strip() if session else ""

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
        user_content = (
            f"Issue title: {issue_title}\n"
            f"Issue detail: {issue_detail}\n"
            f"Customer name: {customer_name or 'unknown'}\n"
            f"API context: {api_context or {}}\n\n"
            f"Transcript:\n{transcript or '(no transcript yet)'}"
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
        summary = (resp.choices[0].message.content or "").strip()
        if summary:
            return summary, transcript
    except Exception as exc:
        logger.warning("escalation_llm_summary_failed err=%s", type(exc).__name__)

    return (
        _fallback_summary(
            issue_title=issue_title,
            issue_detail=issue_detail,
            transcript=transcript,
            customer_name=customer_name,
        ),
        transcript,
    )
