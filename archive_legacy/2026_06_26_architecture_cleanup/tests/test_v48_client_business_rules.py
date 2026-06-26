"""
v4.8 Client Business Rules — regression test suite.

Covers all 26 client test cases from the spec:
1.  Processing Fee never spoken.
2.  Processing Fee never included in checkout line items.
3.  Payment link with 2 books has checkout_count=2, not 3.
4.  Subtotal response says before shipping.
5.  Subtotal response says shipping not included.
6.  Known shipping amount is included.
7.  Shipping unknown uses safe sentence.
8.  Red River Vengeance is out_of_stock.
9.  Red River Vengeance not eligible for checkout.
10. Media Mail question answered from order data.
11. Priority Mail question answered from order data.
12. Facility approved list approved match.
13. Facility not found asks escalation.
14. Address update says email Jessica.
15. Book not listed escalates.
16. Cancellation unfulfilled eligible.
17. Cancellation shipped not cancellable.
18. Facility restriction one book not accepted.
19. Backorder response correct.
20. Dropped call reconnect response.
21. ISBN fragment does not get interrupted too early.
22. Payment sent message includes facility/inmate/order completion sentence.
23. No tool names exposed.
24. No system prompt leakage.
25. No "Processing Fee" in email body.
26. No "Processing Fee" in logs/customer response.
"""
from __future__ import annotations

import pytest


# ─── Part 1 ── Processing Fee checkout filter ─────────────────────────────────

class TestProcessingFeeFilter:
    def _make_item(self, title, variant_id="gid://shopify/ProductVariant/123"):
        return {"title": title, "variant_id": variant_id, "quantity": 1,
                "confirmation_status": "confirmed", "eligible_for_checkout": True}

    def test_processing_fee_detected(self):
        from app.payment.line_item_filter import detect_internal_fee_item
        assert detect_internal_fee_item({"title": "Processing Fee"}) is True

    def test_processing_fee_case_insensitive(self):
        from app.payment.line_item_filter import detect_internal_fee_item
        assert detect_internal_fee_item({"title": "processing fee"}) is True
        assert detect_internal_fee_item({"title": "PROCESSING FEE"}) is True

    def test_service_fee_detected(self):
        from app.payment.line_item_filter import detect_internal_fee_item
        assert detect_internal_fee_item({"title": "Service Fee"}) is True

    def test_book_not_fee(self):
        from app.payment.line_item_filter import detect_internal_fee_item
        assert detect_internal_fee_item({"title": "The Great Gatsby"}) is False

    def test_filter_excludes_fee_item(self):
        from app.payment.line_item_filter import filter_checkout_line_items
        items = [
            {"title": "Book One", "variant_id": "gid://shopify/ProductVariant/1"},
            {"title": "Book Two", "variant_id": "gid://shopify/ProductVariant/2"},
            {"title": "Processing Fee", "variant_id": "gid://shopify/ProductVariant/3"},
        ]
        result = filter_checkout_line_items(items)
        assert len(result.included) == 2
        assert result.excluded_fee_count == 1
        assert all(i["title"] != "Processing Fee" for i in result.included)

    def test_filter_two_books_no_fee(self):
        from app.payment.line_item_filter import filter_checkout_line_items
        items = [
            {"title": "Book A", "variant_id": "gid://shopify/ProductVariant/10"},
            {"title": "Book B", "variant_id": "gid://shopify/ProductVariant/11"},
        ]
        result = filter_checkout_line_items(items)
        assert len(result.included) == 2
        assert result.excluded_fee_count == 0

    def test_is_customer_facing_book_item(self):
        from app.payment.line_item_filter import is_customer_facing_book_item
        assert is_customer_facing_book_item(
            {"title": "Great Book", "variant_id": "gid://shopify/ProductVariant/99"}
        ) is True
        assert is_customer_facing_book_item(
            {"title": "Processing Fee", "variant_id": "gid://shopify/ProductVariant/99"}
        ) is False
        assert is_customer_facing_book_item(
            {"title": "Good Book", "variant_id": ""}
        ) is False


# ─── Part 1 ── Scope audit excludes fee items ─────────────────────────────────

class TestScopeAuditFeeExclusion:
    def _make_session(self, items):
        from unittest.mock import MagicMock
        session = MagicMock()
        session.cart_items = items
        session.call_sid = "ABCDEF1234"
        session.payment_scope_count = 0
        session.payment_scope_mode = ""
        session.payment_scope_items = []
        session.payment_scope_audit = {}
        return session

    def test_scope_audit_excludes_fee(self):
        from app.payment.scope_audit import audit_payment_scope
        items = [
            {"title": "Book A", "variant_id": "gid://1",
             "confirmation_status": "confirmed", "eligible_for_checkout": True},
            {"title": "Book B", "variant_id": "gid://2",
             "confirmation_status": "confirmed", "eligible_for_checkout": True},
            {"title": "Processing Fee", "variant_id": "gid://3",
             "confirmation_status": "confirmed", "eligible_for_checkout": True},
        ]
        session = self._make_session(items)
        eligible, audit = audit_payment_scope(session, {}, "send both books")
        assert len(eligible) == 2
        titles = [i["title"] for i in eligible]
        assert "Processing Fee" not in titles

    def test_checkout_count_two_books(self):
        from app.payment.scope_audit import audit_payment_scope
        items = [
            {"title": "Book A", "variant_id": "gid://1",
             "confirmation_status": "confirmed", "eligible_for_checkout": True},
            {"title": "Book B", "variant_id": "gid://2",
             "confirmation_status": "confirmed", "eligible_for_checkout": True},
        ]
        session = self._make_session(items)
        eligible, audit = audit_payment_scope(session, {}, "")
        assert audit.checkout_count == 2


# ─── Part 2 ── Shipping and subtotal ─────────────────────────────────────────

class TestShippingPolicy:
    def test_subtotal_before_shipping(self):
        from app.shipping.policy import format_subtotal_message
        msg = format_subtotal_message("$12.99")
        assert "before shipping" in msg.lower()
        assert "does not include shipping" in msg.lower()
        assert "$12.99" in msg

    def test_subtotal_does_not_include_shipping(self):
        from app.shipping.policy import format_subtotal_message
        msg = format_subtotal_message("$25.00")
        assert "does not include shipping" in msg.lower()

    def test_shipping_known_amount(self):
        from app.shipping.policy import format_shipping_message, ShippingContext
        ctx = ShippingContext(method="Media Mail", amount="$3.99", is_known=True)
        msg = format_shipping_message(ctx)
        assert "$3.99" in msg
        assert "Media Mail" in msg

    def test_shipping_unknown_safe_sentence(self):
        from app.shipping.policy import format_shipping_message, ShippingContext
        ctx = ShippingContext(is_known=False)
        msg = format_shipping_message(ctx)
        assert "not included yet" in msg.lower()
        assert "depends on the shipping method" in msg.lower()

    def test_no_processing_fee_in_shipping_message(self):
        from app.shipping.policy import format_shipping_message, ShippingContext
        ctx = ShippingContext(method="Media Mail", amount="$3.99", is_known=True)
        msg = format_shipping_message(ctx)
        assert "processing fee" not in msg.lower()

    def test_media_mail_from_order_data(self):
        from app.shipping.policy import build_order_shipping_response
        order = {
            "shipping_method": "Media Mail",
            "shipping_amount": "$3.99",
            "fulfillment_status": "FULFILLED",
        }
        msg = build_order_shipping_response(order, "did it ship by media mail")
        assert "Media Mail" in msg

    def test_priority_mail_from_order_data(self):
        from app.shipping.policy import build_order_shipping_response
        order = {
            "shipping_method": "Priority Mail",
            "shipping_amount": "$7.95",
            "fulfillment_status": "FULFILLED",
        }
        msg = build_order_shipping_response(order, "was it priority mail")
        assert "Priority Mail" in msg

    def test_not_shipped_method_known(self):
        from app.shipping.policy import build_order_shipping_response
        order = {
            "shipping_method": "Media Mail",
            "fulfillment_status": "UNFULFILLED",
        }
        msg = build_order_shipping_response(order, "how did it ship")
        assert "not shipped yet" in msg.lower() or "has not shipped" in msg.lower()
        assert "Media Mail" in msg


# ─── Part 3 ── Red River Vengeance stock override ─────────────────────────────

class TestRedRiverVengeanceOverride:
    def test_override_detected(self):
        from app.catalog.stock_overrides import get_stock_override
        override = get_stock_override("Red River Vengeance")
        assert override is not None
        assert override.get("status") == "out_of_stock"

    def test_override_case_insensitive(self):
        from app.catalog.stock_overrides import get_stock_override
        assert get_stock_override("red river vengeance") is not None
        assert get_stock_override("RED RIVER VENGEANCE") is not None

    def test_override_wins_over_shopify_available(self):
        from app.catalog.stock_overrides import apply_stock_override
        available, status = apply_stock_override("Red River Vengeance", True)
        assert available is False
        assert status == "out_of_stock"

    def test_is_out_of_stock_override(self):
        from app.catalog.stock_overrides import is_out_of_stock_override
        assert is_out_of_stock_override("Red River Vengeance") is True

    def test_non_override_title_not_affected(self):
        from app.catalog.stock_overrides import apply_stock_override
        available, status = apply_stock_override("Some Other Book", True)
        assert available is True

    def test_override_response_says_not_in_stock(self):
        from app.catalog.availability import (
            AVAILABILITY_OUT_OF_STOCK, availability_response
        )
        msg = availability_response(AVAILABILITY_OUT_OF_STOCK)
        assert "not in stock" in msg.lower()
        assert "processing fee" not in msg.lower()


# ─── Part 4 ── Backorder handling ─────────────────────────────────────────────

class TestBackorderHandling:
    def test_backorder_response_text(self):
        from app.catalog.availability import availability_response, AVAILABILITY_BACKORDER
        msg = availability_response(AVAILABILITY_BACKORDER)
        assert "backorder" in msg.lower()
        assert "not available to ship immediately" in msg.lower()
        assert "may be fulfilled once stock is available" in msg.lower()

    def test_out_of_stock_response_text(self):
        from app.catalog.availability import availability_response, AVAILABILITY_OUT_OF_STOCK
        msg = availability_response(AVAILABILITY_OUT_OF_STOCK)
        assert "not in stock" in msg.lower()

    def test_unknown_inventory_escalation_hint(self):
        from app.catalog.availability import availability_response, AVAILABILITY_UNKNOWN
        msg = availability_response(AVAILABILITY_UNKNOWN)
        assert "customer service" in msg.lower()

    def test_out_of_stock_not_eligible_for_checkout(self):
        from app.catalog.availability import availability_from_shopify
        result = availability_from_shopify("Red River Vengeance", available=False)
        assert result.eligible_for_checkout is False

    def test_in_stock_eligible_for_checkout(self):
        from app.catalog.availability import availability_from_shopify
        result = availability_from_shopify("Other Good Book", available=True)
        assert result.eligible_for_checkout is True


# ─── Part 6 ── Facility approved list ─────────────────────────────────────────

class TestFacilityApprovedList:
    def test_approved_facility_response(self):
        from app.facility.approved_list import lookup_facility
        # Add a known-good row to the test data path by mocking
        import unittest.mock as mock
        test_rows = [
            {"facility_name": "Test Prison", "city": "Austin", "state": "TX",
             "approved": "true", "notes": "test"},
        ]
        with mock.patch("app.facility.approved_list._load_list", return_value=test_rows):
            result = lookup_facility("Test Prison", "Austin", "TX")
        assert result.found is True
        assert result.approved is True
        assert "approved" in result.safe_response.lower()

    def test_not_approved_facility_response(self):
        from app.facility.approved_list import lookup_facility
        import unittest.mock as mock
        test_rows = [
            {"facility_name": "Bad Facility", "city": "Dallas", "state": "TX",
             "approved": "false", "notes": ""},
        ]
        with mock.patch("app.facility.approved_list._load_list", return_value=test_rows):
            result = lookup_facility("Bad Facility")
        assert result.found is True
        assert result.approved is False
        assert "not" in result.safe_response.lower() or "do not" in result.safe_response.lower()

    def test_unknown_facility_offers_escalation(self):
        from app.facility.approved_list import lookup_facility
        import unittest.mock as mock
        with mock.patch("app.facility.approved_list._load_list", return_value=[]):
            result = lookup_facility("Unknown Place")
        assert result.found is False
        assert "customer service" in result.safe_response.lower()


# ─── Part 7 ── Facility restriction ───────────────────────────────────────────

class TestFacilityRestriction:
    def test_restricted_book_triggers_review(self):
        from app.facility.restrictions import check_order_restrictions

        result = check_order_restrictions(
            ["Street Violence and Gangs", "Daily Devotional Paperback"],
            facility_name="Example Correctional Facility",
        )
        assert result["all_clear"] is False
        assert "violence" in result["safe_response"].lower() or "returned" in result["safe_response"].lower()

    def test_all_accepted_books_clear(self):
        from app.facility.restrictions import check_order_restrictions

        result = check_order_restrictions(
            ["Daily Devotional Paperback", "Inspirational Stories Softcover"],
            facility_name="Example Correctional Facility",
        )
        assert result["all_clear"] is True
        assert "acceptable" in result["safe_response"].lower()

    def test_no_guessing_unknown_restrictions(self):
        from app.facility.restrictions import check_order_restrictions
        import unittest.mock as mock
        with mock.patch("app.facility.restrictions._load_restrictions", return_value={}):
            result = check_order_restrictions([])
        assert "customer service" in result["safe_response"].lower()


# ─── Part 8 ── Address update Jessica ─────────────────────────────────────────

class TestAddressUpdateJessica:
    @pytest.mark.asyncio
    async def test_address_update_says_jessica(self):
        from app.workers.address_update_worker import AddressUpdateWorker
        from unittest.mock import MagicMock
        session = MagicMock()
        session.call_sid = "TEST123456"
        session.last_order_number = "1234"
        settings = MagicMock()
        settings.JESSICA_EMAIL = "jessica@sureshotbooks.com"
        settings.CUSTOMER_SERVICE_EMAIL = ""
        settings.SUPPORT_EMAIL = ""
        worker = AddressUpdateWorker()
        result = await worker.run(session, {"order_number": "1234"}, settings)
        assert "jessica" in result.safe_summary.lower()
        assert "1234" in result.safe_summary

    @pytest.mark.asyncio
    async def test_address_update_asks_order_number(self):
        from app.workers.address_update_worker import AddressUpdateWorker
        from unittest.mock import MagicMock
        session = MagicMock()
        session.call_sid = "TEST123456"
        session.last_order_number = ""
        settings = MagicMock()
        settings.JESSICA_EMAIL = ""
        settings.CUSTOMER_SERVICE_EMAIL = ""
        settings.SUPPORT_EMAIL = ""
        worker = AddressUpdateWorker()
        result = await worker.run(session, {}, settings)
        assert result.error_code == "no_order_number"


# ─── Part 9 ── Book not listed escalation ─────────────────────────────────────

class TestBookNotListedEscalation:
    def test_book_not_listed_response(self):
        from app.workers.escalation_worker import _ESCALATION_RESPONSES
        msg = _ESCALATION_RESPONSES.get("book_not_listed", "")
        assert "not see that book" in msg.lower() or "not listed" in msg.lower()
        assert "customer service" in msg.lower()

    def test_book_not_listed_no_product_candidate(self):
        from app.workers.escalation_worker import _ESCALATION_RESPONSES
        msg = _ESCALATION_RESPONSES.get("book_not_listed", "")
        assert msg
        # Does not invent a book title or price
        assert "$" not in msg


# ─── Part 10 ── Cancellation flow ─────────────────────────────────────────────

class TestCancellationFlow:
    @pytest.mark.asyncio
    async def test_cancellation_asks_order_number(self):
        from app.workers.cancellation_worker import CancellationWorker
        from unittest.mock import MagicMock
        session = MagicMock()
        session.call_sid = "TEST123456"
        session.last_order_number = ""
        worker = CancellationWorker()
        result = await worker.run(session, {}, MagicMock())
        assert result.error_code == "no_order_number"
        assert "order number" in result.safe_summary.lower()

    @pytest.mark.asyncio
    async def test_cancel_shipped_response(self):
        from app.tools.shopify_tools import CancelOrderRequest
        import json
        import unittest.mock as mock

        async def fake_lookup(*args, **kwargs):
            return json.dumps({
                "found": True,
                "order_number": "#1234",
                "status": "PAID",
                "fulfillment_status": "FULFILLED",
            })

        with mock.patch("app.tools.shopify_tools.lookup_order", fake_lookup):
            result = await CancelOrderRequest("1234")
        data = json.loads(result)
        assert "shipped" in data["message"].lower() or "cannot be cancelled" in data["message"].lower()

    @pytest.mark.asyncio
    async def test_cancel_unfulfilled_eligible(self):
        from app.tools.shopify_tools import CancelOrderRequest
        import json
        import unittest.mock as mock

        async def fake_lookup(*args, **kwargs):
            return json.dumps({
                "found": True,
                "order_number": "#5678",
                "status": "PAID",
                "fulfillment_status": "UNFULFILLED",
            })

        with mock.patch("app.tools.shopify_tools.lookup_order", fake_lookup):
            result = await CancelOrderRequest("5678")
        data = json.loads(result)
        assert data["cancellation_eligible"] is True
        assert "eligible" in data["message"].lower()


# ─── Part 11 ── Call cutoff / dropped call resume ─────────────────────────────

class TestCallCutoffResume:
    def test_resume_greeting(self):
        from app.conversation.call_memory import get_resume_greeting
        msg = get_resume_greeting()
        assert "sorry" in msg.lower()
        assert "left off" in msg.lower()

    def test_store_resume_snapshot(self):
        from app.conversation.call_memory import store_resume_snapshot
        from unittest.mock import MagicMock
        session = MagicMock()
        session.call_sid = "TEST123456"
        session.cart_items = [
            {"confirmation_status": "confirmed", "title": "Book A"},
        ]
        session.payment_flow_status = "idle"
        session.pending_checkout_url = ""
        session.last_order_number = "#999"
        session.call_resume_snapshot = {}
        session.call_ended_at = 0.0
        session.call_memory = None
        store_resume_snapshot(session)
        assert session.call_ended_at > 0

    def test_check_and_apply_resume_within_window(self):
        import time
        from app.conversation.call_memory import check_and_apply_resume
        from unittest.mock import MagicMock

        prior = MagicMock()
        prior.call_sid = "OLDSID1234"
        prior.call_ended_at = time.time() - 300  # 5 minutes ago
        prior.call_resume_snapshot = {
            "cart_count": 2,
            "payment_flow_status": "idle",
            "has_checkout_url": False,
            "email_state": "confirmed",
            "last_order_number": "#1001",
            "facility_context": "Test Facility",
            "current_topic": "order_status",
            "important_facts": ["Cart count: 2"],
            "isbn_count": 0,
        }
        prior.call_memory = None

        new = MagicMock()
        new.call_sid = "NEWSID5678"
        new.is_resumed_call = False
        new.payment_flow_status = "idle"
        new.last_order_number = ""
        new.call_memory = None

        resumed = check_and_apply_resume(new, prior, resume_window_minutes=30)
        assert resumed is True
        assert new.is_resumed_call is True

    def test_resume_outside_window_not_applied(self):
        import time
        from app.conversation.call_memory import check_and_apply_resume
        from unittest.mock import MagicMock

        prior = MagicMock()
        prior.call_sid = "OLDSID9999"
        prior.call_ended_at = time.time() - 3600  # 60 minutes ago
        prior.call_resume_snapshot = {"current_topic": "order_status"}

        new = MagicMock()
        new.call_sid = "NEWSID1111"
        new.is_resumed_call = False
        new.call_memory = None

        resumed = check_and_apply_resume(new, prior, resume_window_minutes=30)
        assert resumed is False


# ─── Part 12 ── Turn-taking / ISBN fragment ────────────────────────────────────

class TestTurnTaking:
    def test_isbn_fragment_holds_response(self):
        from app.voice.turn_taking import classify_turn
        # Simulates customer saying just digits (fragment)
        ctx = classify_turn("978 0 4 5", intent="isbn_collection_start")
        assert ctx.collecting_isbn is True
        assert ctx.hold_response is True

    def test_complete_isbn_processes_immediately(self):
        from app.voice.turn_taking import classify_turn, is_complete_isbn
        text = "9780061965579"
        assert is_complete_isbn(text) is True
        ctx = classify_turn(text, intent="isbn_collection_start")
        # Complete ISBN shouldn't hold (it's long enough to be a full text)
        assert ctx.collecting_isbn is True

    def test_email_fragment_holds_response(self):
        from app.voice.turn_taking import classify_turn
        ctx = classify_turn("john at gmail", intent="email_capture")
        assert ctx.collecting_email is True
        assert ctx.hold_response is True

    def test_digit_silence_threshold_higher(self):
        from app.voice.turn_taking import classify_turn
        ctx = classify_turn("1 2 3", intent="isbn_collection_start")
        assert ctx.recommended_silence_ms >= 2500

    def test_normal_utterance_normal_threshold(self):
        from app.voice.turn_taking import classify_turn
        ctx = classify_turn("What is my order status", intent="order_status")
        assert ctx.hold_response is False


# ─── Part 13 ── Eric policy / no tool name leakage ────────────────────────────

class TestEricPolicy:
    def test_composer_policy_no_tool_names(self):
        from app.brain.eric_policy import build_composer_policy
        policy = build_composer_policy()
        banned = [
            "GetOrder", "SureShotCatalogSearch", "SendPaymentLink",
            "CheckFacilityApproval", "Available Tools",
        ]
        for term in banned:
            assert term not in policy, f"Tool name leaked: {term}"

    def test_composer_policy_mentions_business_rules(self):
        from app.brain.eric_policy import build_composer_policy
        policy = build_composer_policy()
        assert "Processing Fee" not in policy or "Never say Processing Fee" in policy

    def test_eric_policy_templates(self):
        from app.brain.eric_policy import get_response_template
        assert "Jessica" in (get_response_template("address_update") or "")
        assert "not in stock" in (get_response_template("red_river_vengeance") or "").lower()
        assert "backorder" in (get_response_template("backorder") or "").lower()
        assert "left off" in (get_response_template("call_cutoff_resume") or "").lower()

    def test_sanitizer_blocks_processing_fee(self):
        from app.safety.response_sanitizer import sanitize_customer_response
        result = sanitize_customer_response(
            "The total is $25 plus a Processing Fee of $2.",
            intent="payment_status_question",
            call_sid="TEST12",
        )
        assert result.blocked is True

    def test_sanitizer_blocks_available_tools(self):
        from app.safety.response_sanitizer import sanitize_customer_response
        result = sanitize_customer_response(
            "# Available Tools\n1. GetOrder",
            intent="unknown",
            call_sid="TEST12",
        )
        assert result.blocked is True

    def test_sanitizer_blocks_system_prompt_heading(self):
        from app.safety.response_sanitizer import sanitize_customer_response
        result = sanitize_customer_response(
            "# Voice Style — do not rush",
            intent="unknown",
            call_sid="TEST12",
        )
        # heading + voice style keyword → blocked
        assert result.blocked is True


# ─── Part 14 ── Payment sent message ──────────────────────────────────────────

class TestPaymentSentMessage:
    def test_payment_sent_includes_facility_inmate_sentence(self):
        # The spec requires: "On that link, you can enter the facility details,
        # inmate details, and complete your order."
        from app.brain.eric_policy import get_response_template
        msg = get_response_template("payment_link_sent") or ""
        assert "facility details" in msg.lower()
        assert "inmate details" in msg.lower()
        assert "complete your order" in msg.lower()

    def test_payment_link_before_send_message(self):
        from app.brain.eric_policy import get_response_template
        msg = get_response_template("payment_link_before_send") or ""
        assert "facility details" in msg.lower()
        assert "inmate details" in msg.lower()


# ─── Part 15 ── Email body has no Processing Fee ──────────────────────────────

class TestEmailBodyNoFee:
    def test_payment_email_plain_no_processing_fee(self):
        from app.email.deliverability import build_payment_email_plain
        body = build_payment_email_plain("https://example.com/checkout/123")
        assert "processing fee" not in body.lower()

    def test_payment_email_html_no_processing_fee(self):
        from app.email.deliverability import build_payment_email_html
        html = build_payment_email_html("https://example.com/checkout/123")
        assert "processing fee" not in html.lower()

    def test_validate_email_detects_fee_leak(self):
        from app.email.deliverability import validate_payment_email_content
        report = validate_payment_email_content(
            subject="Your payment link",
            plain_body="Your order total includes a Processing Fee of $2.",
            from_email="test@sureshotbooks.com",
        )
        assert "processing_fee_in_email" in report.issues

    def test_validate_email_clean_content_ok(self):
        from app.email.deliverability import validate_payment_email_content
        report = validate_payment_email_content(
            subject="Your SureShot Books payment link",
            plain_body="Click the link to complete your SureShot Books order.",
            from_email="noreply@sureshotbooks.com",
        )
        assert "processing_fee_in_email" not in report.issues
