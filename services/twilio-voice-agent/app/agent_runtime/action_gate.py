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

_IDENTITY_PIPELINE = frozenset({
    "identity_question", "agent_name_question", "name_question",
})
_IDENTITY_SUPERVISOR = frozenset({"identity"})
_COMPANY_PIPELINE = frozenset({"company_question", "company_origin_question"})
_JOB_PIPELINE = frozenset({"job_question", "what_do_you_do"})
_PRESERVE_INTENTS = frozenset({
    "identity_question", "agent_name_question", "name_question",
    "company_question", "company_origin_question", "job_question", "what_do_you_do",
    "repeat_clarification", "frustration_repair", "keepalive_question",
    "vague_book_request", "unknown", "small_talk", "greeting",
})

_NAME_Q = re.compile(
    r"\b("
    r"what(?:'s| is) your name|who are you|your name\??|"
    r"asking about your name|asking about what is your name|"
    r"not asking about your job|i am asking about your name"
    r")\b",
    re.I,
)
_COMPANY_IDENTITY_PAT = re.compile(
    r"\b("
    r"sureshot|sureshort|showshort|what company|who do you work|"
    r"are you .* assistant|are you .* book|are you with|you are with"
    r")\b",
    re.I,
)
_CATALOG_MISROUTE_BLOCK_PAT = re.compile(
    r"\b("
    r"assistant|agent|you are|sureshot|sureshort|showshort|"
    r"social book|support|what company|who do you work|what did you say|"
    r"what is your job|how can i make|black office|short short book|"
    r"not .* assistant|are you .* assistant|are you .* book"
    r")\b",
    re.I,
)
_FRUSTRATION_BLOCK_PAT = re.compile(
    r"\b("
    r"not working|why not responding|why are you not responding|what the hell|"
    r"what the fuck|damn|ridiculous|you are not|not working good|this is not working"
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
    semantic_intent: str = ""
    blocked_worker: str = ""
    product_search_blocked: bool = False

    @property
    def safe_intent(self) -> str:
        return self.semantic_intent

    def to_dict(self) -> dict:
        return {
            "allowed": self.allowed,
            "action": self.action,
            "reason": self.reason,
            "semantic_intent": self.semantic_intent,
            "safe_intent": self.semantic_intent,
            "blocked_worker": self.blocked_worker,
            "product_search_blocked": self.product_search_blocked,
        }


def is_name_question(text: str) -> bool:
    return bool(_NAME_Q.search((text or "").strip()))


def is_company_identity_question(text: str) -> bool:
    return bool(_COMPANY_IDENTITY_PAT.search((text or "").strip()))


def is_frustration_complaint(text: str) -> bool:
    return bool(_FRUSTRATION_BLOCK_PAT.search((text or "").strip()))


def preserve_semantic_intent(
    pipeline_intent: str,
    supervisor_intent: str,
    text: str,
    defect_cls: str = "",
) -> str:
    """Preserve user semantic intent — only defect patterns may suggest replacements."""
    if is_name_question(text):
        return "identity_question"
    if is_company_identity_question(text):
        return "company_question"
    if is_frustration_complaint(text):
        return "frustration_repair"
    if pipeline_intent in _IDENTITY_PIPELINE or supervisor_intent in _IDENTITY_SUPERVISOR:
        return pipeline_intent if pipeline_intent in _IDENTITY_PIPELINE else "identity_question"
    if pipeline_intent in _JOB_PIPELINE:
        return pipeline_intent
    if supervisor_intent == "job_question":
        return "job_question"
    if pipeline_intent in _COMPANY_PIPELINE or supervisor_intent == "company_question":
        return pipeline_intent if pipeline_intent in _COMPANY_PIPELINE else "company_question"
    if pipeline_intent == "repeat_clarification" or supervisor_intent == "repeat_clarification":
        return "repeat_clarification"
    if pipeline_intent == "frustration_repair" or supervisor_intent == "frustration_repair":
        return "frustration_repair"
    if pipeline_intent == "vague_book_request":
        return "vague_book_request"
    if pipeline_intent == "keepalive_question":
        return "keepalive_question"
    if defect_cls == "company_identity":
        return "company_question"
    if defect_cls in ("frustration_repair", "frustration_or_identity", "repair_mode"):
        return "frustration_repair"
    if defect_cls == "repeat_clarification":
        return "repeat_clarification"
    if defect_cls == "keepalive":
        return "keepalive_question"
    if pipeline_intent in _PRESERVE_INTENTS:
        return pipeline_intent
    return pipeline_intent or supervisor_intent or "unknown"


def _has_valid_isbn(text: str) -> bool:
    digits = re.sub(r"\D", "", text or "")
    return bool(digits) and (is_isbn(digits) or bool(normalize_isbn(digits)))


def _blocked(
    *,
    reason: str,
    pipeline_intent: str,
    supervisor_intent: str,
    text: str,
    defect_cls: str = "",
) -> ActionGateResult:
    semantic = preserve_semantic_intent(pipeline_intent, supervisor_intent, text, defect_cls)
    return ActionGateResult(
        allowed=False,
        action="product_search",
        reason=reason,
        semantic_intent=semantic,
        blocked_worker="product_search",
        product_search_blocked=True,
    )


def _is_product_search_path(intent: str, supervisor: SupervisorDecision) -> bool:
    return intent in _PRODUCT_SEARCH_INTENTS or supervisor.user_intent in (
        "book_search", "book_topic_allowed",
    )


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

    Router hint alone is never sufficient. Blocking never corrupts semantic intent.
    """
    sid = (call_sid or "")[:6]
    text = (caller_text or "").strip()
    intent = pipeline_intent or router_hint or ""
    sup_intent = supervisor.user_intent or ""

    preserved = preserve_semantic_intent(intent, sup_intent, text)

    # Identity/name turns — preserve semantic intent; still block product-search misroutes
    if is_name_question(text) or intent in _IDENTITY_PIPELINE or sup_intent in _IDENTITY_SUPERVISOR:
        if not _is_product_search_path(intent, supervisor):
            logger.info("action_gate_allowed sid=%s action=%s reason=identity_turn", sid, intent)
            return ActionGateResult(
                allowed=True,
                action=intent or "identity_question",
                reason="identity_turn",
                semantic_intent="identity_question",
            )
        logger.info(
            "action_gate_blocked sid=%s action=product_search reason=identity_turn_misroute",
            sid,
        )
        logger.info("product_search_blocked sid=%s query_safe=%s", sid, text[:60])
        return _blocked(
            reason="identity_turn_misroute",
            pipeline_intent=intent,
            supervisor_intent=sup_intent,
            text=text,
        )

    if intent in _PRESERVE_INTENTS - _PRODUCT_SEARCH_INTENTS and not _is_product_search_path(intent, supervisor):
        return ActionGateResult(
            allowed=True,
            action=intent or "none",
            reason="semantic_turn",
            semantic_intent=preserved,
        )

    if not _is_product_search_path(intent, supervisor):
        return ActionGateResult(
            allowed=True,
            action=intent or "none",
            reason="not_product_search",
            semantic_intent=preserved,
        )

    defect = match_defect_pattern(text)
    if defect and defect.classification not in ("keepalive",):
        logger.info(
            "action_gate_blocked sid=%s action=product_search reason=defect_pattern_%s",
            sid, defect.classification,
        )
        logger.info("product_search_blocked sid=%s query_safe=%s", sid, text[:60])
        return _blocked(
            reason=f"defect_pattern:{defect.classification}",
            pipeline_intent=intent,
            supervisor_intent=sup_intent,
            text=text,
            defect_cls=defect.classification,
        )

    if _CATALOG_MISROUTE_BLOCK_PAT.search(text) or _FRUSTRATION_BLOCK_PAT.search(text):
        logger.info(
            "action_gate_blocked sid=%s action=product_search reason=agent_identity_or_generic",
            sid,
        )
        logger.info("product_search_blocked sid=%s query_safe=%s", sid, text[:60])
        return _blocked(
            reason="agent_identity_or_generic",
            pipeline_intent=intent,
            supervisor_intent=sup_intent,
            text=text,
        )

    if is_generic_product_query(text):
        logger.info(
            "action_gate_blocked sid=%s action=product_search reason=generic_query",
            sid,
        )
        return _blocked(
            reason="generic_query",
            pipeline_intent=intent,
            supervisor_intent=sup_intent,
            text=text,
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
            semantic_intent="isbn_search",
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
            semantic_intent="explicit_title_search",
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
            semantic_intent="explicit_author_search",
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
            semantic_intent="explicit_subject_search",
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
                semantic_intent=intent,
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
            semantic_intent="product_search_selecting",
        )

    if action_gate_approved is False:
        logger.info(
            "action_gate_blocked sid=%s action=product_search reason=explicitly_denied",
            sid,
        )
        return _blocked(
            reason="not_action_gate_approved",
            pipeline_intent=intent,
            supervisor_intent=sup_intent,
            text=text,
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
            semantic_intent=intent,
        )

    if _EXPLICIT_AUTHOR_PAT.search(text) and len(text.split()) >= 3:
        logger.info(
            "action_gate_allowed sid=%s action=product_search reason=author_or_title_phrase",
            sid,
        )
        return ActionGateResult(
            allowed=True,
            action="product_search",
            reason="author_or_title_phrase",
            semantic_intent=intent,
        )

    if not has_explicit_book_search_context(text):
        logger.info(
            "action_gate_blocked sid=%s action=product_search reason=no_explicit_context",
            sid,
        )
        logger.info("product_search_blocked sid=%s query_safe=%s", sid, text[:60])
        return _blocked(
            reason="no_explicit_book_context",
            pipeline_intent=intent,
            supervisor_intent=sup_intent,
            text=text,
        )

    logger.info(
        "action_gate_allowed sid=%s action=product_search reason=explicit_book_context",
        sid,
    )
    return ActionGateResult(
        allowed=True,
        action="product_search",
        reason="explicit_book_context",
        semantic_intent=intent,
    )
