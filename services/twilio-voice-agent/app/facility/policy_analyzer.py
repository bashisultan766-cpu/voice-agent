"""Offline facility policy analyzer — deterministic rules with optional LLM summary."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

from .policy_models import FacilityPolicyRecord
from .policy_text_cleaner import clean_policy_text, extract_mail_policy_sections

logger = logging.getLogger(__name__)

_ANALYSIS_PATH = Path(__file__).parent.parent / "data" / "facility_policy_analysis.json"
_INDEX_PATH = Path(__file__).parent.parent / "data" / "facility_policy_knowledge_index.json"
_RAW_DIR = Path(__file__).parent.parent / "data" / "facility_policy_raw"

_BOOL = Optional[bool]


@dataclass
class FacilityPolicyAnalysis:
    facility_name: str
    state: str = ""
    policy_url: str = ""
    policy_url_hash: str = ""
    books_allowed: _BOOL = None
    magazines_allowed: _BOOL = None
    newspapers_allowed: _BOOL = None
    vendor_required: _BOOL = None
    publisher_only_required: _BOOL = None
    amazon_only_allowed: _BOOL = None
    used_books_allowed: _BOOL = None
    hardcover_allowed: _BOOL = None
    explicit_content_restricted: _BOOL = None
    nudity_restricted: _BOOL = None
    violence_restricted: _BOOL = None
    maps_restricted: _BOOL = None
    staples_binding_restricted: _BOOL = None
    policy_summary: str = ""
    evidence_snippets: list[str] = field(default_factory=list)
    confidence: float = 0.0
    escalation_required: bool = True
    source: str = "unknown"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "FacilityPolicyAnalysis":
        return cls(
            facility_name=str(data.get("facility_name") or ""),
            state=str(data.get("state") or ""),
            policy_url=str(data.get("policy_url") or ""),
            policy_url_hash=str(data.get("policy_url_hash") or ""),
            books_allowed=data.get("books_allowed"),
            magazines_allowed=data.get("magazines_allowed"),
            newspapers_allowed=data.get("newspapers_allowed"),
            vendor_required=data.get("vendor_required"),
            publisher_only_required=data.get("publisher_only_required"),
            amazon_only_allowed=data.get("amazon_only_allowed"),
            used_books_allowed=data.get("used_books_allowed"),
            hardcover_allowed=data.get("hardcover_allowed"),
            explicit_content_restricted=data.get("explicit_content_restricted"),
            nudity_restricted=data.get("nudity_restricted"),
            violence_restricted=data.get("violence_restricted"),
            maps_restricted=data.get("maps_restricted"),
            staples_binding_restricted=data.get("staples_binding_restricted"),
            policy_summary=str(data.get("policy_summary") or ""),
            evidence_snippets=list(data.get("evidence_snippets") or []),
            confidence=float(data.get("confidence") or 0.0),
            escalation_required=bool(data.get("escalation_required", True)),
            source=str(data.get("source") or "unknown"),
        )


def url_hash(url: str) -> str:
    return hashlib.sha256((url or "").strip().encode("utf-8")).hexdigest()[:16]


_RULES: list[tuple[str, re.Pattern[str], Any]] = [
    ("magazines_allowed", re.compile(
        r"\b(magazines?|periodicals?)\s+(?:are\s+)?(?:not\s+)?(?:allowed|permitted|accepted)\b", re.I
    ), "magazine_allow"),
    ("magazines_allowed", re.compile(
        r"\b(?:no|not)\s+(?:magazines?|periodicals?)\b", re.I
    ), False),
    ("magazines_allowed", re.compile(
        r"\b(magazines?|periodicals?)\s+(?:prohibited|banned|restricted|not allowed)\b", re.I
    ), False),
    ("newspapers_allowed", re.compile(
        r"\b(?:no|not)\s+newspapers?\b", re.I
    ), False),
    ("newspapers_allowed", re.compile(
        r"\bnewspapers?\s+(?:prohibited|banned|restricted|not allowed)\b", re.I
    ), False),
    ("books_allowed", re.compile(
        r"\b(?:no|not)\s+books?\b", re.I
    ), False),
    ("books_allowed", re.compile(
        r"\bbooks?\s+(?:prohibited|banned|restricted|not allowed)\b", re.I
    ), False),
    ("books_allowed", re.compile(
        r"\b(?:paperback|softcover)\s+books?\s+(?:are\s+)?(?:allowed|permitted|accepted)\b", re.I
    ), True),
    ("books_allowed", re.compile(
        r"\bbooks?\s+(?:are\s+)?(?:allowed|permitted|accepted)\b", re.I
    ), True),
    ("vendor_required", re.compile(
        r"\b(direct from (?:the )?(?:publisher|vendor)|approved vendor|"
        r"must (?:be|come) from (?:the )?(?:publisher|vendor)|publisher only)\b",
        re.I,
    ), True),
    ("publisher_only_required", re.compile(
        r"\b(publisher only|direct from publisher|ship(?:ped)? direct from publisher)\b", re.I
    ), True),
    ("amazon_only_allowed", re.compile(
        r"\b(amazon only|only amazon)\b", re.I
    ), True),
    ("used_books_allowed", re.compile(
        r"\b(no used books?|new books? only|used books? (?:not|are not) allowed)\b", re.I
    ), False),
    ("hardcover_allowed", re.compile(
        r"\b(no hardcover|hardcovers? (?:not|are not) (?:allowed|permitted|accepted)|"
        r"hardcovers? (?:banned|prohibited))\b",
        re.I,
    ), False),
    ("explicit_content_restricted", re.compile(
        r"\b(explicit|erotica|pornograph|sexually explicit)\b", re.I
    ), True),
    ("nudity_restricted", re.compile(
        r"\b(nudity|nude|naked)\b", re.I
    ), True),
    ("violence_restricted", re.compile(
        r"\b(violen(?:ce|t)|gang|weapon)\b", re.I
    ), True),
    ("maps_restricted", re.compile(
        r"\b(maps?|atlas|cartograph)\s+(?:not|prohibited|banned|restricted)\b", re.I
    ), True),
    ("staples_binding_restricted", re.compile(
        r"\b(staples?|spiral binding|metal binding)\s+(?:not|prohibited|banned)\b", re.I
    ), True),
]


def _snippet(text: str, match: re.Match[str], max_len: int = 160) -> str:
    start = max(0, match.start() - 40)
    end = min(len(text), match.end() + 80)
    snippet = text[start:end].strip()
    snippet = re.sub(r"\s+", " ", snippet)
    if len(snippet) > max_len:
        snippet = snippet[: max_len - 3] + "..."
    return snippet


def _apply_rules(text: str) -> tuple[dict[str, Any], list[str], int]:
    findings: dict[str, Any] = {}
    evidence: list[str] = []
    hits = 0

    for field_name, pattern, value in _RULES:
        m = pattern.search(text)
        if not m:
            continue
        resolved = value
        if value == "magazine_allow":
            resolved = "not" not in m.group(0).lower()
        if field_name not in findings:
            findings[field_name] = resolved
            evidence.append(_snippet(text, m))
            hits += 1

    return findings, evidence, hits


def _merge_csv_record(
    analysis: FacilityPolicyAnalysis,
    record: FacilityPolicyRecord,
) -> FacilityPolicyAnalysis:
    """CSV structured fields fill gaps; ingested policy takes precedence when confident."""
    if analysis.books_allowed is None and record.allowed_books is not None:
        analysis.books_allowed = record.allowed_books
    if analysis.magazines_allowed is None and record.allowed_magazines is not None:
        analysis.magazines_allowed = record.allowed_magazines
    if analysis.newspapers_allowed is None and record.allowed_newspapers is not None:
        analysis.newspapers_allowed = record.allowed_newspapers

    lower_notes = " ".join(
        [record.policy_summary] + list(record.restricted_content or [])
        + list(record.disallowed_formats or [])
        + list(record.disallowed_keywords or [])
    ).lower()

    if "hardcover" in lower_notes and analysis.hardcover_allowed is None:
        analysis.hardcover_allowed = False
    if "vendor" in lower_notes or "publisher" in lower_notes:
        if analysis.vendor_required is None:
            analysis.vendor_required = True
    if record.policy_summary and not analysis.policy_summary:
        analysis.policy_summary = record.policy_summary[:400]

    if record.has_actionable_policy():
        analysis.confidence = max(analysis.confidence, 0.65)
        analysis.source = "csv+policy" if analysis.source == "ingested_policy" else "csv"
    return analysis


def analyze_policy_text(
    cleaned_text: str,
    *,
    facility_name: str,
    state: str = "",
    policy_url: str = "",
    csv_record: Optional[FacilityPolicyRecord] = None,
) -> FacilityPolicyAnalysis:
    """Analyze cleaned policy text with deterministic rules."""
    focused = extract_mail_policy_sections(clean_policy_text(cleaned_text))
    findings, evidence, hits = _apply_rules(focused)

    analysis = FacilityPolicyAnalysis(
        facility_name=facility_name,
        state=state,
        policy_url=policy_url,
        policy_url_hash=url_hash(policy_url) if policy_url else "",
        books_allowed=findings.get("books_allowed"),
        magazines_allowed=findings.get("magazines_allowed"),
        newspapers_allowed=findings.get("newspapers_allowed"),
        vendor_required=findings.get("vendor_required"),
        publisher_only_required=findings.get("publisher_only_required"),
        amazon_only_allowed=findings.get("amazon_only_allowed"),
        used_books_allowed=findings.get("used_books_allowed"),
        hardcover_allowed=findings.get("hardcover_allowed"),
        explicit_content_restricted=findings.get("explicit_content_restricted"),
        nudity_restricted=findings.get("nudity_restricted"),
        violence_restricted=findings.get("violence_restricted"),
        maps_restricted=findings.get("maps_restricted"),
        staples_binding_restricted=findings.get("staples_binding_restricted"),
        evidence_snippets=evidence[:8],
        confidence=min(0.95, 0.35 + hits * 0.12) if hits else 0.0,
        source="ingested_policy" if hits else "unknown",
    )

    if hits:
        parts: list[str] = []
        if analysis.magazines_allowed is False:
            parts.append("Magazines appear restricted.")
        elif analysis.magazines_allowed is True:
            parts.append("Magazines appear allowed.")
        if analysis.books_allowed is False:
            parts.append("Books appear restricted.")
        elif analysis.books_allowed is True:
            parts.append("Books appear allowed.")
        if analysis.vendor_required:
            parts.append("Vendor or publisher shipment may be required.")
        if analysis.hardcover_allowed is False:
            parts.append("Hardcover books may be restricted.")
        analysis.policy_summary = " ".join(parts)[:400]

    if csv_record is not None:
        analysis = _merge_csv_record(analysis, csv_record)

    analysis.escalation_required = analysis.confidence < 0.55 and not (
        csv_record and csv_record.has_actionable_policy()
    )

    if os.getenv("FEATURE_POLICY_LLM_SUMMARY", "").lower() == "true" and os.getenv("OPENAI_API_KEY"):
        analysis = _maybe_llm_summary(analysis, focused)

    return analysis


def _maybe_llm_summary(
    analysis: FacilityPolicyAnalysis,
    text: str,
) -> FacilityPolicyAnalysis:
    """Optional offline LLM summary — never called during live calls."""
    try:
        from openai import OpenAI

        client = OpenAI()
        prompt = (
            "Summarize correctional facility mail policy restrictions in 2-3 sentences. "
            "Only state what is explicitly supported by the text. Text:\n"
            f"{text[:3500]}"
        )
        resp = client.chat.completions.create(
            model=os.getenv("POLICY_LLM_MODEL", "gpt-4o-mini"),
            messages=[{"role": "user", "content": prompt}],
            max_tokens=200,
            temperature=0,
        )
        summary = (resp.choices[0].message.content or "").strip()
        if summary:
            analysis.policy_summary = summary[:400]
            analysis.confidence = min(0.98, analysis.confidence + 0.1)
    except Exception as exc:
        logger.warning("policy_llm_summary_skipped err=%s", exc)
    return analysis


def analyze_from_csv_record(record: FacilityPolicyRecord) -> FacilityPolicyAnalysis:
    """Build analysis from CSV-only data when no ingested policy text exists."""
    notes = record.policy_summary
    if record.restricted_content:
        notes += " " + ", ".join(record.restricted_content)
    analysis = analyze_policy_text(
        notes,
        facility_name=record.facility_name,
        state=record.state,
        policy_url=record.policy_url,
        csv_record=record,
    )
    if record.has_actionable_policy():
        analysis.source = "csv"
        analysis.confidence = max(analysis.confidence, 0.7)
        analysis.escalation_required = False
    elif record.policy_url and not analysis.policy_summary:
        analysis.escalation_required = True
        analysis.source = "csv_url_only"
    return analysis


def build_knowledge_index(analyses: list[FacilityPolicyAnalysis]) -> dict[str, Any]:
    """Build searchable index for live agent (no raw policy text)."""
    by_name: dict[str, str] = {}
    by_state: dict[str, list[str]] = {}
    by_url_hash: dict[str, str] = {}
    keywords: dict[str, list[str]] = {
        "magazines_restricted": [],
        "newspapers_restricted": [],
        "books_restricted": [],
        "vendor_required": [],
        "hardcover_restricted": [],
    }

    for a in analyses:
        key = re.sub(r"[^a-z0-9]", "", a.facility_name.lower())
        by_name[key] = a.facility_name
        if a.state:
            by_state.setdefault(a.state.upper(), []).append(a.facility_name)
        if a.policy_url_hash:
            by_url_hash[a.policy_url_hash] = a.facility_name
        if a.magazines_allowed is False:
            keywords["magazines_restricted"].append(a.facility_name)
        if a.newspapers_allowed is False:
            keywords["newspapers_restricted"].append(a.facility_name)
        if a.books_allowed is False:
            keywords["books_restricted"].append(a.facility_name)
        if a.vendor_required:
            keywords["vendor_required"].append(a.facility_name)
        if a.hardcover_allowed is False:
            keywords["hardcover_restricted"].append(a.facility_name)

    return {
        "version": "1",
        "facility_count": len(analyses),
        "by_normalized_name": by_name,
        "by_state": by_state,
        "by_policy_url_hash": by_url_hash,
        "keywords": keywords,
        "analyses": {a.facility_name: a.to_dict() for a in analyses},
    }


def load_policy_analyses(*, reload: bool = False) -> dict[str, FacilityPolicyAnalysis]:
    global _ANALYSIS_CACHE, _ANALYSIS_LOADED
    if _ANALYSIS_LOADED and not reload:
        return _ANALYSIS_CACHE
    _ANALYSIS_CACHE = {}
    if _ANALYSIS_PATH.exists():
        try:
            payload = json.loads(_ANALYSIS_PATH.read_text(encoding="utf-8"))
            for row in payload.get("analyses") or []:
                if isinstance(row, dict) and row.get("facility_name"):
                    a = FacilityPolicyAnalysis.from_dict(row)
                    _ANALYSIS_CACHE[a.facility_name] = a
        except Exception as exc:
            logger.warning("facility_policy_analysis_load_failed err=%s", exc)
    _ANALYSIS_LOADED = True
    return _ANALYSIS_CACHE


def load_knowledge_index(*, reload: bool = False) -> dict[str, Any]:
    global _INDEX_CACHE, _INDEX_LOADED
    if _INDEX_LOADED and not reload:
        return _INDEX_CACHE
    _INDEX_CACHE = {}
    if _INDEX_PATH.exists():
        try:
            _INDEX_CACHE = json.loads(_INDEX_PATH.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("facility_policy_index_load_failed err=%s", exc)
    _INDEX_LOADED = True
    return _INDEX_CACHE


_ANALYSIS_CACHE: dict[str, FacilityPolicyAnalysis] = {}
_ANALYSIS_LOADED = False
_INDEX_CACHE: dict[str, Any] = {}
_INDEX_LOADED = False
