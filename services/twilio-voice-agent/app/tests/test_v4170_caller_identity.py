"""Tests for caller identity / returning-caller recognition (v4.17)."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.agent_runtime import caller_identity as ci
from app.state.models import SessionState


def _make_session(**kwargs) -> SessionState:
    defaults = dict(
        session_id="s-id",
        call_sid="CA_ID0001",
        from_number="+15551234567",
        to_number="+18005551234",
    )
    defaults.update(kwargs)
    return SessionState(**defaults)


class _FakeClient:
    def __init__(self, configured=True, customer=None):
        self.configured = configured
        self._customer = customer

    async def execute(self, query, variables=None):
        if self._customer is None:
            return {"data": {"customers": {"edges": []}}}
        return {"data": {"customers": {"edges": [{"node": self._customer}]}}}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    # Default: no cached profile / customer cache hit. Tests opt into Shopify.
    async def _no_profile(_phone):
        return None

    async def _no_cache(self, _phone):
        return None

    monkeypatch.setattr(ci, "get_caller_profile", _no_profile)
    from app.sync.repositories import CustomerCache

    monkeypatch.setattr(CustomerCache, "get_by_phone", _no_cache)
    yield


class TestE164:
    def test_us_local(self):
        assert ci.to_e164("(555) 123-4567") == "+15551234567"

    def test_already_e164(self):
        assert ci.to_e164("+15551234567") == "+15551234567"

    def test_eleven_digits(self):
        assert ci.to_e164("15551234567") == "+15551234567"

    def test_empty(self):
        assert ci.to_e164("") == ""


class TestReturningCaller:
    def test_returning_caller_greeting_by_shopify_phone(self, monkeypatch):
        customer = {
            "id": "gid://shopify/Customer/42",
            "firstName": "Berlin",
            "lastName": "Wright",
            "phone": "+15551234567",
            "orders": {
                "edges": [
                    {"node": {
                        "name": "#1042",
                        "displayFinancialStatus": "PAID",
                        "displayFulfillmentStatus": "FULFILLED",
                    }}
                ]
            },
        }
        monkeypatch.setattr(
            "app.shopify.client.get_shopify_client",
            lambda: _FakeClient(customer=customer),
        )
        import asyncio

        info = asyncio.run(ci.get_caller_info("+15551234567"))
        assert info["known"] is True
        assert info["first_name"] == "Berlin"
        assert info["allowed_greeting_name"] == "Berlin"
        assert info["phone_match_confidence"] == "high"
        greeting = ci.build_greeting(info)
        assert "Berlin" in greeting
        assert "SureShot Books" in greeting

    def test_no_private_details_from_phone_match_only(self, monkeypatch):
        customer = {
            "id": "gid://shopify/Customer/42",
            "firstName": "Berlin",
            "lastName": "Wright",
            "phone": "+15551234567",
            "email": "berlin@example.com",
            "orders": {"edges": [{"node": {
                "name": "#1042", "displayFinancialStatus": "PAID",
                "displayFulfillmentStatus": "FULFILLED",
            }}]},
        }
        monkeypatch.setattr(
            "app.shopify.client.get_shopify_client",
            lambda: _FakeClient(customer=customer),
        )
        import asyncio

        info = asyncio.run(ci.get_caller_info("+15551234567"))
        # No email or address in the safe result.
        flat = str(info).lower()
        assert "berlin@example.com" not in flat
        assert "email" not in info
        # Order summary must not leak line items or totals.
        for order in info["recent_orders"]:
            assert set(order.keys()) <= {"order_number", "status", "fulfillment_status"}

        # Applying to session must NOT mark phone/email as verified.
        session = _make_session()
        ci.apply_to_session(session, info)
        assert session.caller_name == "Berlin"
        assert session.is_returning_caller is True
        assert bool(getattr(session, "verified_email", False)) is False
        assert bool(getattr(session, "verified_phone", False)) is False


class TestUnknownCaller:
    def test_unknown_caller_no_name_greeting(self, monkeypatch):
        monkeypatch.setattr(
            "app.shopify.client.get_shopify_client",
            lambda: _FakeClient(configured=True, customer=None),
        )
        import asyncio

        info = asyncio.run(ci.get_caller_info("+15559998888"))
        assert info["known"] is False
        assert info["allowed_greeting_name"] == ""
        greeting = ci.build_greeting(info)
        assert "SureShot Books" in greeting
        # Generic greeting must not contain a name placeholder.
        assert "Hi ," not in greeting
