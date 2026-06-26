"""Normalized facility policy records (Step 6)."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Optional

ContentType = Literal["book", "magazine", "newspaper", "subscription", "unknown"]


def normalize_facility_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


@dataclass
class FacilityPolicyRecord:
    facility_name: str
    normalized_facility_name: str = ""
    state: str = ""
    facility_type: str = ""
    allowed_books: Optional[bool] = None
    allowed_magazines: Optional[bool] = None
    allowed_newspapers: Optional[bool] = None
    restricted_content: list[str] = field(default_factory=list)
    policy_summary: str = ""
    policy_url: str = ""
    source_file: str = ""
    source_row: int = 0
    confidence: float = 1.0
    last_updated: str = ""
    aliases: list[str] = field(default_factory=list)
    city: str = ""
    allowed_formats: list[str] = field(default_factory=list)
    disallowed_formats: list[str] = field(default_factory=list)
    disallowed_keywords: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.normalized_facility_name:
            self.normalized_facility_name = normalize_facility_name(self.facility_name)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "FacilityPolicyRecord":
        return cls(
            facility_name=str(data.get("facility_name") or ""),
            normalized_facility_name=str(
                data.get("normalized_facility_name")
                or normalize_facility_name(str(data.get("facility_name") or ""))
            ),
            state=str(data.get("state") or "").upper(),
            facility_type=str(data.get("facility_type") or ""),
            allowed_books=data.get("allowed_books"),
            allowed_magazines=data.get("allowed_magazines"),
            allowed_newspapers=data.get("allowed_newspapers"),
            restricted_content=list(data.get("restricted_content") or []),
            policy_summary=str(data.get("policy_summary") or ""),
            policy_url=str(data.get("policy_url") or ""),
            source_file=str(data.get("source_file") or ""),
            source_row=int(data.get("source_row") or 0),
            confidence=float(data.get("confidence") or 1.0),
            last_updated=str(data.get("last_updated") or ""),
            aliases=list(data.get("aliases") or []),
            city=str(data.get("city") or ""),
            allowed_formats=[str(x).lower() for x in (data.get("allowed_formats") or [])],
            disallowed_formats=[str(x).lower() for x in (data.get("disallowed_formats") or [])],
            disallowed_keywords=[str(x).lower() for x in (data.get("disallowed_keywords") or [])],
        )

    def has_actionable_policy(self) -> bool:
        return bool(
            self.policy_summary
            or self.allowed_books is not None
            or self.allowed_magazines is not None
            or self.allowed_newspapers is not None
            or self.restricted_content
            or self.allowed_formats
            or self.disallowed_formats
        )
