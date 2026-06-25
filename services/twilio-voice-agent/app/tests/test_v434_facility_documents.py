"""Tests for facility_resolver and document rule extraction."""
from __future__ import annotations

from app.facility.document_index import extract_rules_from_text
from app.facility.facility_resolver import (
    facility_from_order,
    facility_name_in_text,
    facility_rejection_intent,
)
from app.facility.guidelines_registry import load_guidelines, lookup_facility_guideline


def test_rejection_intent_detected():
    assert facility_rejection_intent("Some books arrived but two were returned")
    assert facility_rejection_intent("Why didn't my book come to the prison?")
    assert not facility_rejection_intent("What is your return policy?")


def test_facility_name_in_caller_text():
    load_guidelines(reload=True)
    assert "Example" in facility_name_in_text(
        "My order went to Example Correctional Facility"
    )


def test_facility_from_order_shipping():
    load_guidelines(reload=True)
    name = facility_from_order({
        "shipping_address": {
            "company": "Example Correctional Facility",
            "address1": "123 Prison Rd",
            "city": "Example City",
        },
        "note": "",
        "tags": [],
        "custom_attributes": {},
    })
    fac = lookup_facility_guideline(name)
    assert fac is not None


def test_extract_rules_from_pdf_like_text():
    text = """
    Mail rules for Example Facility.
    No hardcover books. Paperback only.
    Violence and gang content is prohibited.
    Read full rules at https://example.org/mail-rules
    """
    rules = extract_rules_from_text(text)
    assert "hardcover" in rules["disallowed_formats"]
    assert "violence" in rules["disallowed_keywords"]
    assert rules["website_url"].startswith("https://")
