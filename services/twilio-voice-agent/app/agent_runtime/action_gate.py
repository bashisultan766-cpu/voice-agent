"""LLM Action Gate — no worker runs from router hint alone (v4.13)."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Optional

from ..catalog.query_specificity import (
    has_explicit_book_search_context,
    is_generic_product_query,
    score_product_query_specificity,
)
from ..tools.isbn import is_isbn, normalize_isbn
from .defect_pattern_guard import match_defect_pattern
from .types import SupervisorDecision

logger = logging.getLogger(__name__)

_PRODUCT_SEARCH_INTENTS = frozenset({
    "product_search", "book_title_search", "author_search",
    "explicit_title_search", "explicit_author_search", "explicit_subject_search",
})

_IDENTITY_BLOCK_PAT = re.compile(
    r"\b("
    r"assistant|agent|you are|your name|your job|sureshot|sureshort|showshort|"
    r"social book|support|what company|who do you work|what did you say|"
    r"what is your job|how can i make|black office|i am asking|short short book|"
    r"not .* assistant|are you .* assistant|are you .* book"
    r")\b",
    re.I,
)
_FRUSTRATION_BLOCK_PAT = re.compile(
    r"\b("
    r"not working|why not responding|why are you not responding|what the hell|"
    r"what the fuck|damn|ridiculous|you are not"
    r")\b",
    re.I,
)
_EXPLICIT_TITLE_PAT = re.compile(
    r"\b(book called|title is|titled|named|book titled)\b",
    re.I,
)
_EXPLICIT_AUTHOR_PAT = re.compile(r"\b(author is|written by|by author)\b", re.I)
_EXPLICIT_SUBJECT_PAT = re.compile(
    r"\b(do you have books about|books about|books on)\b",
    re.I,
)
_SELECTED_PAT = re.compile(r"\b(yes|that one|the first|number one|second one)\b", re.I)
_MIN_SPECIFICITY_SCORE = 4


@dataclass(frozen=True)
class ActionGateResult:
    allowed: bool
    action: str
    reason: str
    safe_intent: str = ""
    blocked_worker: str = ""

    def to_dict(self) -> dict:
        return {
            "allowed": self.allowed,
            "action": self.action,
            "reason": self.reason,
            "safe_intent": self.safe_intent,
            "blocked_worker": self.blocked_worker,
        }


def _has_valid_isbn(text: str) -> bool:
    digits = re.sub(r"\D", "", text or "")
    return bool(digits) and (is_isbn(digits) or bool(normalize_isbn(digits)))


def _rewrite_intent(text: str, defect_cls: str = "") -> str:
    t = (text or "").lower()
    if defect_cls == "company_identity" or re.search(
        r"\b(sureshot|sureshort|showshort|social book|assistant)\b", t
    ):
        return "company_question"
    if defect_cls in ("frustration_repair", "frustration_or_identity", "repair_mode"):
        return "frustration_repair"
    if defect_cls == "repeat_clarification":
        return "repeat_clarification"
    if defect_cls == "keepalive":
        return "keepalive_question"
    if _FRUSTRATION_BLOCK_PAT.search(t):
        return "frustration_repair"
    if _IDENTITY_BLOCK_PAT.search(t):
        return "company_question"
    return "unknown"


def evaluate_action_gate(
    *,
    call_sid: str,
    caller_text: str,
    supervisor: SupervisorDecision,
    pipeline_intent: str,
    router_hint: str = "",
    conversation_mode: str = "idle",
    expected_next: str = "",
    query_specificity_score: int = 0,
    action_gate_approved: Optional[bool] = None,
) -> ActionGateResult:
    """
    Decide whether product_search (and related catalog workers) may run.

    Router hint alone is never sufficient.
    """
    sid = (call_sid or "")[:6]
    text = (caller_text or "").strip()
    intent = pipeline_intent or router_hint or ""

    # Always block catalog/identity misroutes regardless of resolved intent
    defect = match_defect_pattern(text)
    if defect and defect.classification not in ("keepalive",):
        safe = _rewrite_intent(text, defect.classification)
        logger.info(
            "action_gate_blocked sid=%s action=product_search reason=defect_pattern_%s",
            sid, defect.classification,
        )
        logger.info("product_search_blocked sid=%s query_safe=%s", sid, text[:60])
        return ActionGateResult(
            allowed=False,
            action="product_search",
            reason=f"defect_pattern:{defect.classification}",
            safe_intent=safe,
            blocked_worker="product_search",
        )

    if _IDENTITY_BLOCK_PAT.search(text) or _FRUSTRATION_BLOCK_PAT.search(text):
        safe = _rewrite_intent(text)
        logger.info(
            "action_gate_blocked sid=%s action=product_search reason=agent_identity_or_generic",
            sid,
        )
        logger.info("product_search_blocked sid=%s query_safe=%s", sid, text[:60])
        return ActionGateResult(
            allowed=False,
            action="product_search",
            reason="agent_identity_or_generic",
            safe_intent=safe,
            blocked_worker="product_search",
        )

    if is_generic_product_query(text) and intent in _PRODUCT_SEARCH_INTENTS.union({
        "vague_book_request", "unknown",
    }):
        logger.info(
            "action_gate_blocked sid=%s action=product_search reason=generic_query",
            sid,
        )
        return ActionGateResult(
            allowed=False,
            action="product_search",
            reason="generic_query",
            safe_intent="vague_book_request",
            blocked_worker="product_search",
        )

    if intent not in _PRODUCT_SEARCH_INTENTS and supervisor.user_intent not in (
        "book_search", "book_topic_allowed",
    ):
        return ActionGateResult(
            allowed=True,
            action=intent or "none",
            reason="not_product_search",
            safe_intent=intent,
        )

    if _has_valid_isbn(text):
        logger.info(
            "action_gate_allowed sid=%s action=product_search reason=valid_isbn",
            sid,
        )
        return ActionGateResult(
            allowed=True,
            action="isbn_lookup",
            reason="valid_isbn",
            safe_intent="isbn_search",
        )

    if _EXPLICIT_TITLE_PAT.search(text):
        logger.info(
            "action_gate_allowed sid=%s action=product_search reason=explicit_title",
            sid,
        )
        return ActionGateResult(
            allowed=True,
            action="product_search",
            reason="explicit_book_context",
            safe_intent="explicit_title_search",
        )

    if _EXPLICIT_AUTHOR_PAT.search(text):
        logger.info(
            "action_gate_allowed sid=%s action=product_search reason=explicit_author",
            sid,
        )
        return ActionGateResult(
            allowed=True,
            action="product_search",
            reason="explicit_author",
            safe_intent="explicit_author_search",
        )

    if _EXPLICIT_SUBJECT_PAT.search(text):
        logger.info(
            "action_gate_allowed sid=%s action=product_search reason=explicit_subject",
            sid,
        )
        return ActionGateResult(
            allowed=True,
            action="product_search",
            reason="explicit_subject",
            safe_intent="explicit_subject_search",
        )

    if conversation_mode in ("book_collection", "isbn_collection") and expected_next:
        spec = score_product_query_specificity(text)
        if spec.is_searchable and spec.score >= 3:
            logger.info(
                "action_gate_allowed sid=%s action=product_search reason=active_state_specific",
                sid,
            )
            return ActionGateResult(
                allowed=True,
                action="product_search",
                reason="active_state_specific_query",
                safe_intent=intent,
            )

    if _SELECTED_PAT.search(text) and conversation_mode == "book_collection":
        logger.info(
            "action_gate_allowed sid=%s action=product_search reason=selected_option",
            sid,
        )
        return ActionGateResult(
            allowed=True,
            action="product_search",
            reason="customer_selected_option",
            safe_intent="product_search_selecting",
        )

    if action_gate_approved is False:
        logger.info(
            "action_gate_blocked sid=%s action=product_search reason=explicitly_denied",
            sid,
        )
        return ActionGateResult(
            allowed=False,
            action="product_search",
            reason="not_action_gate_approved",
            safe_intent=_rewrite_intent(text),
            blocked_worker="product_search",
        )

    spec = score_product_query_specificity(text)
    if spec.is_searchable and spec.score >= _MIN_SPECIFICITY_SCORE:
        logger.info(
            "action_gate_allowed sid=%s action=product_search reason=high_specificity",
            sid,
        )
        return ActionGateResult(
            allowed=True,
            action="product_search",
            reason="high_specificity",
            safe_intent=intent,
        )

    if _AUTHOR_PAT.search(text) and len(text.split()) >= 3:
        logger.info(
            "action_gate_allowed sid=%s action=product_search reason=author_or_title_phrase",
            sid,
        )
        return ActionGateResult(
            allowed=True,
            action="product_search",
            reason="author_or_title_phrase",
            safe_intent=intent,
        )

    if not has_explicit_book_search_context(text):
        safe = _rewrite_intent(text)
        logger.info(
            "action_gate_blocked sid=%s action=product_search reason=no_explicit_context",
            sid,
        )
        logger.info("product_search_blocked sid=%s query_safe=%s", sid, text[:60])
        return ActionGateResult(
            allowed=False,
            action="product_search",
            reason="no_explicit_book_context",
            safe_intent=safe,
            blocked_worker="product_search",
        )

    logger.info(
        "action_gate_allowed sid=%s action=product_search reason=explicit_book_context",
        sid,
    )
    return ActionGateResult(
        allowed=True,
        action="product_search",
        reason="explicit_book_context",
        safe_intent=intent,
    )
