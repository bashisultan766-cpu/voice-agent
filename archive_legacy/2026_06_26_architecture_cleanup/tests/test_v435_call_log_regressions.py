"""Regressions from live call CAa1fd — ISBN chunks vs orders, email STT, catalog variant_id."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.commerce_flow_state import normalize_catalog_hit
from app.agent_runtime.order_flow_state import extract_order_number
from app.email.capture import normalize_spoken_email
from app.state.models import SessionState


def _session() -> SessionState:
    return SessionState(
        session_id="v435",
        call_sid="CA_V435",
        from_number="+15551234000",
        to_number="+15559999999",
    )


class TestIsbnNotOrderNumber:
    def test_partial_isbn_not_order(self):
        session = _session()
        session.pending_isbn_buffer = "9780877"
        assert extract_order_number("9 2 9 8 7.", session) is None
        assert extract_order_number("97808777", session) is None

    def test_real_order_still_works(self):
        assert extract_order_number("order number 4521") == "4521"


class TestEmailSttFixes:
    def test_therategmail_fixed(self):
        assert normalize_spoken_email("bashisultan766 at therategmail dot com") == (
            "bashisultan766@gmail.com"
        )

    def test_periodgmail_fixed(self):
        assert normalize_spoken_email("bashisultan766 at periodgmail dot com") == (
            "bashisultan766@gmail.com"
        )


class TestCatalogVariantNormalization:
    def test_variant_from_variants_array(self):
        hit = normalize_catalog_hit({
            "title": "Test Book",
            "variants": [{"id": "gid://shopify/ProductVariant/1", "price": "8.50"}],
        })
        assert hit["variant_id"] == "gid://shopify/ProductVariant/1"
        assert hit["price"] == "8.50"
