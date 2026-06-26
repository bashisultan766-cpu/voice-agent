"""
Facility policy service — search, content checks, restriction explanations.

Reads normalized policy data from ``app/data/facility_policies_normalized.json``.
Never invents policy; low-confidence matches return ``escalation_required=true``.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Optional

from .policy_analyzer import FacilityPolicyAnalysis, load_policy_analyses
from .policy_models import ContentType, FacilityPolicyRecord, normalize_facility_name
from .product_content_classifier import classify_product_content

logger = logging.getLogger(__name__)

_DATA_PATH = Path(__file__).parent.parent / "data" / "facility_policies_normalized.json"
_INDEX_PATH = Path(__file__).parent.parent / "data" / "facility_policy_index.json"
_ANALYSIS_INDEX_PATH = (
    Path(__file__).parent.parent / "data" / "facility_policy_knowledge_index.json"
)

_ESCALATION_MESSAGE = (
    "I don't have enough confirmed policy detail for that facility. "
    "I can forward this to our team to verify."
)

_LOW_CONFIDENCE_THRESHOLD = 0.55
_POLICY_URL_ONLY_MESSAGE = (
    "I found a policy source for that facility, but I don't have enough detail "
    "to confirm it confidently. I can forward this to our team."
)

_STATE_ALIASES: dict[str, str] = {
    "ALABAMA": "AL",
    "ALASKA": "AK",
    "ARIZONA": "AZ",
    "ARKANSAS": "AR",
    "CALIFORNIA": "CA",
    "COLORADO": "CO",
    "COLUMBIA": "DC",
    "CONNECTICUT": "CT",
    "DELAWARE": "DE",
    "FLORIDA": "FL",
    "GEORGIA": "GA",
    "HAWAII": "HI",
    "IDAHO": "ID",
    "ILLINOIS": "IL",
    "INDIANA": "IN",
    "IOWA": "IA",
    "KANSAS": "KS",
    "KENTUCKY": "KY",
    "LOUISIANA": "LA",
    "MAINE": "ME",
    "MARYLAND": "MD",
    "MASSACHUSETTS": "MA",
    "MICHIGAN": "MI",
    "MINNESOTA": "MN",
    "MISSISSIPPI": "MS",
    "MISSOURI": "MO",
    "MONTANA": "MT",
    "NEBRASKA": "NE",
    "NEVADA": "NV",
    "NEW HAMPSHIRE": "NH",
    "NEW JERSEY": "NJ",
    "NEW MEXICO": "NM",
    "NEW YORK": "NY",
    "NORTH CAROLINA": "NC",
    "NORTH DAKOTA": "ND",
    "OHIO": "OH",
    "OKLAHOMA": "OK",
    "OREGON": "OR",
    "PENNSYLVANIA": "PA",
    "RHODE ISLAND": "RI",
    "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD",
    "TENNESSEE": "TN",
    "TEXAS": "TX",
    "UTAH": "UT",
    "VERMONT": "VT",
    "VIRGINIA": "VA",
    "WASHINGTON": "WA",
    "WEST VIRGINIA": "WV",
    "WISCONSIN": "WI",
    "WYOMING": "WY",
    "FEDERAL": "US",
}

_CACHE: list[FacilityPolicyRecord] = []
_INDEX: dict[str, Any] = {}
_LOADED = False

_CONTENT_ALIASES: dict[str, ContentType] = {
    "book": "book",
    "books": "book",
    "magazine": "magazine",
    "magazines": "magazine",
    "newspaper": "newspaper",
    "newspapers": "newspaper",
    "subscription": "subscription",
    "subscriptions": "subscription",
    "periodical": "magazine",
}


@dataclass
class PolicyMatch:
    record: FacilityPolicyRecord
    confidence: float
    match_reason: str = ""


def normalize_content_type(value: str) -> ContentType:
    key = (value or "").strip().lower()
    return _CONTENT_ALIASES.get(key, "unknown")  # type: ignore[return-value]


def _normalize_state(value: str) -> str:
    raw = (value or "").strip().upper()
    if not raw:
        return ""
    if len(raw) == 2:
        return raw
    return _STATE_ALIASES.get(raw, raw)


def detect_content_type_from_text(text: str) -> ContentType:
    lower = (text or "").lower()
    if re.search(r"\b(newspaper|paper subscription)s?\b", lower):
        return "newspaper"
    if re.search(r"\b(magazine|periodical)s?\b", lower):
        return "magazine"
    if re.search(r"\b(subscription)\b", lower):
        return "subscription"
    if re.search(r"\b(book|paperback|hardcover|isbn|title)\b", lower):
        return "book"
    return "unknown"


def load_policy_records(*, reload: bool = False) -> list[FacilityPolicyRecord]:
    global _CACHE, _INDEX, _LOADED
    if _LOADED and not reload:
        return _CACHE

    _CACHE = []
    _INDEX = {}

    if _DATA_PATH.exists():
        try:
            with open(_DATA_PATH, encoding="utf-8") as f:
                payload = json.load(f)
            for row in payload.get("facilities") or []:
                if isinstance(row, dict) and row.get("facility_name"):
                    _CACHE.append(FacilityPolicyRecord.from_dict(row))
        except Exception as exc:
            logger.error("facility_policy_load_failed path=%s err=%s", _DATA_PATH, exc)

    if _INDEX_PATH.exists():
        try:
            with open(_INDEX_PATH, encoding="utf-8") as f:
                _INDEX = json.load(f)
        except Exception as exc:
            logger.warning("facility_policy_index_load_failed err=%s", exc)

    if reload:
        load_policy_analyses(reload=True)

    _LOADED = True
    logger.info("facility_policy_loaded count=%d", len(_CACHE))
    return _CACHE


def _analysis_for_record(rec: FacilityPolicyRecord) -> Optional[FacilityPolicyAnalysis]:
    analyses = load_policy_analyses()
    if rec.facility_name in analyses:
        return analyses[rec.facility_name]
    for a in analyses.values():
        if normalize_facility_name(a.facility_name) == rec.normalized_facility_name:
            return a
    return None


def _content_from_analysis(
    analysis: FacilityPolicyAnalysis,
    content_type: ContentType,
) -> Optional[bool]:
    if content_type == "book":
        return analysis.books_allowed
    if content_type == "magazine":
        return analysis.magazines_allowed
    if content_type == "newspaper":
        return analysis.newspapers_allowed
    if content_type == "subscription":
        if analysis.magazines_allowed is False and analysis.newspapers_allowed is False:
            return False
        if analysis.magazines_allowed is True or analysis.newspapers_allowed is True:
            return True
    return None


def _risk_supported_by_analysis(
    analysis: FacilityPolicyAnalysis,
    risk_flag: str,
) -> bool:
    mapping = {
        "explicit": analysis.explicit_content_restricted,
        "nudity": analysis.nudity_restricted,
        "violence": analysis.violence_restricted,
        "maps": analysis.maps_restricted,
        "hardcover": analysis.hardcover_allowed is False,
        "used_book": analysis.used_books_allowed is False,
    }
    val = mapping.get(risk_flag)
    return val is True


def get_facility_policy_analysis(
    facility_name: str,
    *,
    state: Optional[str] = None,
) -> dict[str, Any]:
    """Return ingested policy analysis first, CSV record as fallback metadata."""
    search = search_facility_policy(facility_name, state=state)
    if not search.get("found") or search.get("escalation_required"):
        return {
            **search,
            "analysis_found": False,
        }

    rec = _record_from_search(search, facility_name, state=state)
    if rec is None:
        return {**search, "analysis_found": False}

    analysis = _analysis_for_record(rec)
    if analysis and not analysis.escalation_required:
        payload = analysis.to_dict()
        payload.update({
            "found": True,
            "analysis_found": True,
            "confidence": max(search.get("confidence", 0.0), analysis.confidence),
            "escalation_required": False,
            "source": analysis.source,
            "policy_url": analysis.policy_url or rec.policy_url,
        })
        return payload

    if rec.has_actionable_policy():
        csv_analysis = {
            "facility_name": rec.facility_name,
            "state": rec.state,
            "policy_url": rec.policy_url,
            "books_allowed": rec.allowed_books,
            "magazines_allowed": rec.allowed_magazines,
            "newspapers_allowed": rec.allowed_newspapers,
            "policy_summary": rec.policy_summary,
            "confidence": search.get("confidence", 0.0),
            "escalation_required": False,
            "analysis_found": True,
            "source": "csv",
            "found": True,
        }
        return csv_analysis

    return {
        "found": True,
        "analysis_found": False,
        "facility_name": rec.facility_name,
        "policy_url": rec.policy_url,
        "confidence": search.get("confidence", 0.0),
        "escalation_required": True,
        "message": _ESCALATION_MESSAGE,
    }


def _fuzzy_ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _score_match(
    query_norm: str,
    record: FacilityPolicyRecord,
    *,
    state: str = "",
) -> tuple[float, str]:
    names = [record.normalized_facility_name]
    names.extend(normalize_facility_name(a) for a in record.aliases)

    best = 0.0
    reason = ""
    for name in names:
        if not name:
            continue
        if query_norm == name:
            best = max(best, 0.95)
            reason = reason or "exact_name"
            continue
        if query_norm in name or name in query_norm:
            best = max(best, 0.88)
            reason = reason or "substring_name"
        ratio = _fuzzy_ratio(query_norm, name)
        if ratio >= 0.92:
            best = max(best, 0.9)
            reason = reason or "fuzzy_high"
        elif ratio >= 0.78:
            best = max(best, 0.72)
            reason = reason or "fuzzy_medium"
        elif ratio >= 0.65:
            best = max(best, 0.58)
            reason = reason or "fuzzy_low"

    if state and record.state:
        query_state = _normalize_state(state)
        record_state = _normalize_state(record.state)
        if query_state and record_state:
            if query_state == record_state:
                best = min(1.0, best + 0.08)
                reason = f"{reason}+state" if reason else "state_only"
            else:
                best *= 0.25
                reason = f"{reason}+state_mismatch" if reason else "state_mismatch"

    return best, reason or "weak"


def search_facility_policy(
    facility_name: str,
    *,
    state: Optional[str] = None,
) -> dict[str, Any]:
    """Search facility policy by name with fuzzy matching."""
    records = load_policy_records()
    query_norm = normalize_facility_name(facility_name)
    if not query_norm:
        return {
            "found": False,
            "confidence": 0.0,
            "escalation_required": True,
            "message": "I need the facility name to check its policy.",
        }

    matches: list[PolicyMatch] = []
    for rec in records:
        score, reason = _score_match(query_norm, rec, state=state or "")
        if score >= 0.5:
            matches.append(PolicyMatch(record=rec, confidence=score, match_reason=reason))

    matches.sort(key=lambda m: m.confidence, reverse=True)
    if not matches:
        return {
            "found": False,
            "confidence": 0.0,
            "escalation_required": True,
            "message": (
                f"I don't have a policy record for {facility_name.strip()}. "
                "I can forward this to our team instead of guessing."
            ),
        }

    top = matches[0]
    rec = top.record
    escalation = top.confidence < _LOW_CONFIDENCE_THRESHOLD

    if escalation:
        return {
            "found": False,
            "confidence": round(top.confidence, 3),
            "escalation_required": True,
            "match_reason": top.match_reason,
            "message": (
                f"I'm not confident I have the right policy for {facility_name.strip()}. "
                "I can forward this to our team."
            ),
        }

    if rec.policy_url and not rec.has_actionable_policy():
        return {
            "found": True,
            "confidence": round(top.confidence, 3),
            "escalation_required": True,
            "facility_name": rec.facility_name,
            "policy_url": rec.policy_url,
            "source_file": rec.source_file,
            "message": _POLICY_URL_ONLY_MESSAGE,
        }

    return {
        "found": True,
        "confidence": round(top.confidence, 3),
        "escalation_required": False,
        "facility_name": rec.facility_name,
        "state": rec.state,
        "policy_summary": rec.policy_summary,
        "policy_url": rec.policy_url,
        "allowed_books": rec.allowed_books,
        "allowed_magazines": rec.allowed_magazines,
        "allowed_newspapers": rec.allowed_newspapers,
        "restricted_content": rec.restricted_content,
        "source_file": rec.source_file,
        "source_row": rec.source_row,
        "match_reason": top.match_reason,
        "customer_message": _format_policy_summary(rec),
    }


def _content_allowed(record: FacilityPolicyRecord, content_type: ContentType) -> Optional[bool]:
    if content_type == "book":
        return record.allowed_books
    if content_type == "magazine":
        return record.allowed_magazines
    if content_type == "newspaper":
        return record.allowed_newspapers
    if content_type == "subscription":
        if record.allowed_magazines is False and record.allowed_newspapers is False:
            return False
        if record.allowed_magazines is True or record.allowed_newspapers is True:
            return True
    return None


def check_content_allowed(
    facility_name: str,
    content_type: str,
    *,
    state: Optional[str] = None,
) -> dict[str, Any]:
    """Check whether a content type is allowed at a facility."""
    ctype = normalize_content_type(content_type)
    if ctype == "unknown":
        return {
            "found": False,
            "escalation_required": True,
            "message": "I need to know whether you mean books, magazines, or newspapers.",
        }

    search = search_facility_policy(facility_name, state=state)
    if not search.get("found") or search.get("escalation_required"):
        return {
            **search,
            "content_type": ctype,
        }

    rec = _record_from_search(search, facility_name, state=state)
    if rec is None:
        return search

    analysis = _analysis_for_record(rec)
    if analysis and not analysis.escalation_required:
        allowed = _content_from_analysis(analysis, ctype)
        if allowed is not None:
            label = ctype if ctype != "subscription" else "subscriptions"
            if allowed:
                msg = (
                    f"Based on the facility policy information I have, {label} appear to be "
                    f"allowed at {rec.facility_name}."
                )
            else:
                msg = (
                    f"Based on the facility policy information I have, {label} appear to be "
                    f"restricted at {rec.facility_name}."
                )
            if analysis.policy_summary:
                msg += f" {analysis.policy_summary[:180]}"
            return {
                "found": True,
                "content_type": ctype,
                "allowed": allowed,
                "confidence": max(search.get("confidence", 0.0), analysis.confidence),
                "escalation_required": False,
                "facility_name": rec.facility_name,
                "policy_summary": analysis.policy_summary,
                "policy_url": analysis.policy_url or rec.policy_url,
                "source_file": rec.source_file,
                "source_row": rec.source_row,
                "policy_source": analysis.source,
                "customer_message": msg,
            }

    allowed = _content_allowed(rec, ctype)
    if allowed is None:
        if rec.confidence < _LOW_CONFIDENCE_THRESHOLD:
            return {
                "found": True,
                "content_type": ctype,
                "allowed": None,
                "confidence": min(search.get("confidence", 0.0), rec.confidence),
                "escalation_required": True,
                "facility_name": rec.facility_name,
                "policy_url": rec.policy_url,
                "source_file": rec.source_file,
                "message": (
                    f"I don't have a clear {ctype} policy for {rec.facility_name}. "
                    "I can forward this to our team instead of guessing."
                ),
            }
        if rec.policy_url and not rec.policy_summary:
            return {
                "found": True,
                "content_type": ctype,
                "allowed": None,
                "confidence": search.get("confidence", 0.0),
                "escalation_required": True,
                "policy_url": rec.policy_url,
                "source_file": rec.source_file,
                "message": _POLICY_URL_ONLY_MESSAGE,
            }
        return {
            "found": True,
            "content_type": ctype,
            "allowed": None,
            "confidence": search.get("confidence", 0.0),
            "escalation_required": True,
            "facility_name": rec.facility_name,
            "source_file": rec.source_file,
            "message": (
                f"I don't have a clear {ctype} policy for {rec.facility_name}. "
                "I can forward this to our team instead of guessing."
            ),
        }

    label = ctype if ctype != "subscription" else "subscriptions"
    if allowed:
        msg = (
            f"Based on our policy records, {label} appear to be allowed at "
            f"{rec.facility_name}."
        )
    else:
        msg = (
            f"Based on our policy records, {label} are restricted at "
            f"{rec.facility_name}."
        )
    if rec.policy_summary:
        msg += f" {rec.policy_summary[:180]}"

    return {
        "found": True,
        "content_type": ctype,
        "allowed": allowed,
        "confidence": search.get("confidence", 0.0),
        "escalation_required": False,
        "facility_name": rec.facility_name,
        "policy_summary": rec.policy_summary,
        "policy_url": rec.policy_url,
        "source_file": rec.source_file,
        "source_row": rec.source_row,
        "customer_message": msg,
    }


def _record_from_search(
    search: dict[str, Any],
    facility_name: str,
    *,
    state: Optional[str] = None,
) -> Optional[FacilityPolicyRecord]:
    target_name = search.get("facility_name") or facility_name
    target_state = _normalize_state(search.get("state") or state or "")

    for rec in load_policy_records():
        if rec.facility_name != target_name:
            continue
        if target_state:
            if _normalize_state(rec.state) == target_state:
                return rec
        else:
            return rec

    if target_state:
        for rec in load_policy_records():
            if rec.facility_name == target_name:
                return rec
    return None


def explain_facility_restriction(
    facility_name: str,
    content_type: str = "",
    *,
    product_title: Optional[str] = None,
    state: Optional[str] = None,
    order_number: Optional[str] = None,
    order_items: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Explain a likely restriction using policy data only."""
    return explain_delivery_rejection(
        facility_name,
        product_title=product_title,
        content_type=content_type or None,
        order_context={
            "order_number": order_number or "",
            "order_items": order_items or [],
        },
        state=state,
    )


def explain_delivery_rejection(
    facility_name: str,
    *,
    product_title: Optional[str] = None,
    content_type: Optional[str] = None,
    order_context: Optional[dict[str, Any]] = None,
    state: Optional[str] = None,
) -> dict[str, Any]:
    """Explain delivery rejection using ingested policy + product classification."""
    order_context = order_context or {}
    order_number = str(order_context.get("order_number") or "")
    order_items = list(order_context.get("order_items") or [])

    ctype = normalize_content_type(content_type or "") if content_type else detect_content_type_from_text(
        product_title or ""
    )
    if ctype == "unknown" and product_title:
        classified = classify_product_content(product_title=product_title)
        if classified.content_type != "unknown":
            ctype = classified.content_type
    if ctype == "unknown" and product_title:
        ctype = "book"

    if not facility_name.strip():
        return {
            "found": False,
            "escalation_required": True,
            "needs_facility_name": True,
            "message": (
                "To explain a delivery restriction, I need the correctional facility name. "
                "Which facility was the order sent to?"
            ),
        }

    product_class = classify_product_content(product_title=product_title or "")
    check = check_content_allowed(facility_name, ctype or "book", state=state)
    if check.get("escalation_required") and not check.get("found"):
        return check

    rec = _record_from_search(check, facility_name, state=state)
    if rec is None:
        return {
            **check,
            "escalation_required": True,
            "message": _ESCALATION_MESSAGE,
        }

    analysis = _analysis_for_record(rec)
    parts: list[str] = []
    policy_evidence = False

    if product_title:
        parts.append(f"For '{product_title}' at {rec.facility_name}:")
    else:
        parts.append(f"For {rec.facility_name}:")

    if check.get("allowed") is False:
        policy_evidence = True
        parts.append(
            f"Based on the facility policy information I have, that facility appears to "
            f"restrict {ctype or 'that item'}."
        )
    elif check.get("allowed") is True:
        parts.append(
            f"Based on the facility policy information I have, {ctype or 'that item'} "
            f"appears allowed at this facility."
        )
    else:
        parts.append(_ESCALATION_MESSAGE)

    supported_risks: list[str] = []
    if analysis and product_class.risk_flags:
        for flag in product_class.risk_flags:
            if flag == "unknown":
                continue
            if _risk_supported_by_analysis(analysis, flag):
                supported_risks.append(flag)
                policy_evidence = True

    if supported_risks and product_title:
        risk_text = ", ".join(supported_risks).replace("_", " ")
        parts.append(
            f"Your order may be affected because the product appears to involve {risk_text}, "
            f"which the facility policy may restrict."
        )

    if analysis and analysis.evidence_snippets:
        parts.append(f"Policy note: {analysis.evidence_snippets[0][:140]}")
        policy_evidence = True
    elif rec.policy_summary:
        parts.append(rec.policy_summary[:200])

    if rec.policy_url:
        parts.append("Policy source on file.")

    if order_number and order_items:
        parts.append(f"Order {order_number} items reviewed: {', '.join(order_items[:5])}.")

    if not policy_evidence:
        return {
            **check,
            "found": bool(check.get("found")),
            "escalation_required": True,
            "facility_name": rec.facility_name,
            "content_type": ctype,
            "order_number": order_number,
            "product_title": product_title or "",
            "message": _ESCALATION_MESSAGE,
            "customer_message": _ESCALATION_MESSAGE,
        }

    msg = " ".join(parts)
    if check.get("allowed") is False or supported_risks:
        msg += " I can also forward this to our team to verify the exact facility decision."

    return {
        "found": True,
        "escalation_required": False,
        "facility_name": rec.facility_name,
        "content_type": ctype,
        "allowed": check.get("allowed"),
        "confidence": check.get("confidence", 0.0),
        "policy_summary": (analysis.policy_summary if analysis else rec.policy_summary) or "",
        "policy_url": (analysis.policy_url if analysis else rec.policy_url) or "",
        "source_file": rec.source_file,
        "source_row": rec.source_row,
        "order_number": order_number,
        "product_title": product_title or "",
        "policy_evidence": policy_evidence,
        "customer_message": msg,
    }


def answer_facility_question(
    facility_name: str,
    question: str,
    *,
    content_type: Optional[str] = None,
    product_title: Optional[str] = None,
    state: Optional[str] = None,
) -> dict[str, Any]:
    """Answer a facility policy question from cached analysis/CSV only."""
    q = (question or "").lower()
    ctype = normalize_content_type(content_type or "") if content_type else detect_content_type_from_text(q)
    if ctype == "unknown" and product_title:
        classified = classify_product_content(product_title=product_title)
        ctype = classified.content_type

    if any(w in q for w in ("deliver", "reject", "return", "not delivered", "refund")):
        return explain_delivery_rejection(
            facility_name,
            product_title=product_title,
            content_type=ctype if ctype != "unknown" else None,
            state=state,
        )

    if ctype != "unknown":
        return check_content_allowed(facility_name, ctype, state=state)

    analysis = get_facility_policy_analysis(facility_name, state=state)
    if analysis.get("analysis_found") and not analysis.get("escalation_required"):
        summary = analysis.get("policy_summary") or ""
        msg = f"Based on the facility policy information I have for {analysis.get('facility_name')}:"
        if summary:
            msg += f" {summary[:220]}"
        else:
            bits = []
            if analysis.get("books_allowed") is not None:
                bits.append("Books allowed." if analysis["books_allowed"] else "Books restricted.")
            if analysis.get("magazines_allowed") is not None:
                bits.append(
                    "Magazines allowed." if analysis["magazines_allowed"] else "Magazines restricted."
                )
            msg += " " + " ".join(bits)
        return {
            **analysis,
            "customer_message": msg.strip(),
        }

    search = search_facility_policy(facility_name, state=state)
    if search.get("found") and not search.get("escalation_required"):
        return search

    return {
        "found": False,
        "escalation_required": True,
        "message": _ESCALATION_MESSAGE,
        "customer_message": _ESCALATION_MESSAGE,
    }


def get_policy_source(
    facility_name: str,
    *,
    state: Optional[str] = None,
) -> dict[str, Any]:
    """Return policy source metadata for a facility."""
    search = search_facility_policy(facility_name, state=state)
    if not search.get("found"):
        return {
            "found": False,
            "escalation_required": True,
            "message": search.get("message", ""),
        }
    return {
        "found": True,
        "facility_name": search.get("facility_name", ""),
        "source_file": search.get("source_file", ""),
        "source_row": search.get("source_row", 0),
        "policy_url": search.get("policy_url", ""),
        "confidence": search.get("confidence", 0.0),
        "escalation_required": search.get("escalation_required", False),
    }


def _format_policy_summary(rec: FacilityPolicyRecord) -> str:
    bits = [f"Policy for {rec.facility_name}"]
    if rec.state:
        bits[0] += f", {rec.state}"
    bits[0] += ":"
    if rec.allowed_books is not None:
        bits.append("Books allowed." if rec.allowed_books else "Books restricted.")
    if rec.allowed_magazines is not None:
        bits.append("Magazines allowed." if rec.allowed_magazines else "Magazines restricted.")
    if rec.allowed_newspapers is not None:
        bits.append("Newspapers allowed." if rec.allowed_newspapers else "Newspapers restricted.")
    if rec.policy_summary:
        bits.append(rec.policy_summary[:220])
    if rec.policy_url:
        bits.append(f"Policy link on file.")
    if rec.source_file:
        bits.append(f"Source: {rec.source_file}.")
    return " ".join(bits)
