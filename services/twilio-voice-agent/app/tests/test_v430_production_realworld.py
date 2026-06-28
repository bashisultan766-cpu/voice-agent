"""v4.30 — production cart quantities, branded email, order/refund privacy."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.cart.ledger import CartLedger, CartItem
from app.cart.quantity import MAX_LINE_QUANTITY, parse_spoken_quantity
from app.conversation.call_memory import build_resume_snapshot, check_and_apply_resume
from app.email.deliverability import build_payment_email_bodies
from app.shopify.order_privacy import card_last4_from_transactions, mask_email_for_voice
from app.state.models import SessionState


class TestBulkQuantity:
    def test_fifty_copies(self):
        assert parse_spoken_quantity("I need fifty copies") == 50

    def test_hundred_copies(self):
        assert parse_spoken_quantity("one hundred copies") == 100

    def test_150_copies(self):
        assert parse_spoken_quantity("150 copies") == 150

    def test_max_clamp(self):
        assert parse_spoken_quantity("999 copies") == MAX_LINE_QUANTITY


class TestCartSummary:
    def test_summary_includes_copies_and_subtotal(self):
        ledger = CartLedger()
        ledger.add_candidate(CartItem(
            title="Book A", variant_id="v1", quantity=50, price="10.00",
            confirmation_status="candidate",
        ))
        ledger.confirm_last_candidate()
        ledger.add_candidate(CartItem(
            title="Book B", variant_id="v2", quantity=10, price="12.00",
            confirmation_status="candidate",
        ))
        ledger.confirm_last_candidate()
        text = ledger.cart_summary_text()
        assert "50" in text
        assert "10" in text
        assert "Subtotal before shipping" in text


class TestBrandedPaymentEmail:
    def test_email_has_company_and_button(self):
        _, plain, html = build_payment_email_bodies(
            "https://pay.example.com/x",
            order_lines=[
                {"title": "Book A", "quantity": 2, "price": "10.00"},
            ],
        )
        assert "SureShot Books LLC" in html
        assert "Complete Secure Payment" in html
        assert "Shipping is calculated separately" in plain
        assert "Book A" in html


class TestOrderPrivacy:
    def test_mask_email(self):
        assert mask_email_for_voice("buyer@gmail.com") == "b***@gmail.com"

    def test_card_last4(self):
        txns = [{"paymentDetails": {"number": "•••• •••• •••• 4242"}}]
        assert card_last4_from_transactions(txns) == "4242"

    def test_card_last4_from_refund_transaction_connection(self):
        txns = {
            "edges": [
                {"node": {"paymentDetails": {"number": "•••• 9999"}}},
            ],
        }
        assert card_last4_from_transactions(txns) == "9999"


class TestCartResume:
    def test_resume_restores_cart_items(self):
        prior = SessionState(
            session_id="p", call_sid="CA_PRIOR01", from_number="+1", to_number="+2",
        )
        prior.cart_items = [{
            "title": "Book A",
            "variant_id": "v1",
            "quantity": 50,
            "price": "10",
            "confirmation_status": "confirmed",
            "isbn": "",
        }]
        prior.call_ended_at = __import__("time").time()
        prior.call_resume_snapshot = build_resume_snapshot(prior)

        new_sess = SessionState(
            session_id="n", call_sid="CA_NEW001", from_number="+1", to_number="+2",
        )
        applied = check_and_apply_resume(new_sess, prior, resume_window_minutes=30)
        assert applied
        assert len(new_sess.cart_items) == 1
        assert new_sess.cart_items[0]["quantity"] == 50


class TestOrderLookupSuggestedResponse:
    @pytest.mark.asyncio
    async def test_lookup_includes_suggested_response(self):
        from app.tools import shopify_tools as st

        fake_node = {
            "id": "gid://shopify/Order/1",
            "name": "#1001",
            "displayFinancialStatus": "PAID",
            "displayFulfillmentStatus": "UNFULFILLED",
            "email": "buyer@gmail.com",
            "customer": {"firstName": "John", "lastName": "Doe", "email": "buyer@gmail.com"},
            "subtotalPriceSet": {"shopMoney": {"amount": "20.00", "currencyCode": "USD"}},
            "totalShippingPriceSet": {"shopMoney": {"amount": "5.00", "currencyCode": "USD"}},
            "lineItems": {"edges": [{"node": {"title": "Book", "quantity": 1}}]},
            "fulfillments": [],
            "transactions": [{"paymentDetails": {"number": "xxxx1234"}}],
        }

        async def fake_execute(query, variables=None):
            return {"data": {"orders": {"edges": [{"node": fake_node}]}}}

        with patch.object(st, "get_shopify_client") as mock_client:
            mock_client.return_value.configured = True
            mock_client.return_value.execute = fake_execute
            raw = await st.lookup_order(
                order_number="1001",
                email="buyer@gmail.com",
            )
        data = json.loads(raw)
        assert data.get("suggested_response")
        assert data.get("payment_card_last4") == "1234"
        assert "b***@gmail.com" in data.get("email_masked", "")
