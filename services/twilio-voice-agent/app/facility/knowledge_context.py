"""
Facility reference data for the LLM system context (v4.34).

Client documents:
  app/data/facility_guidelines.csv  — export Google Sheets here
  app/data/facility_docs/*.pdf      — client PDF guidelines
  python -m app.scripts.ingest_facility_documents  — build facility_guidelines.json
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState


def _mentioned_facility(text: str, session: "SessionState | None") -> str:
    from .facility_resolver import facility_name_in_text

    hit = facility_name_in_text(text)
    if hit:
        return hit

    t = (text or "").lower()
    if session:
        for attr in ("last_facility_name", "facility_name"):
            name = (getattr(session, attr, "") or "").strip()
            if name and name.lower() in t:
                return name
    return ""


def build_facility_knowledge_block(
    session: "SessionState | None" = None,
    caller_text: str = "",
) -> str:
    from .facility_resolver import facility_rejection_intent
    from .guidelines_registry import guidelines_for_llm_context

    facility_name = _mentioned_facility(caller_text, session)
    if not facility_name and session:
        facility_name = (getattr(session, "last_facility_name", "") or "").strip()

    block = guidelines_for_llm_context(facility_name=facility_name)

    if facility_rejection_intent(caller_text):
        block += (
            "\n\nCALLER INTENT: books partially arrived / returned / not accepted. "
            "Use check_order_facility_restrictions or reconcile_order_facility_books "
            "once you have the order number. Explain why each rejected title likely "
            "violated facility rules, cite the official website URL, and offer "
            "similar allowed paperback alternatives. Be empathetic — this is about "
            "their loved one receiving mail."
        )
    return block
