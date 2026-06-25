"""v4.36 — drop shipping fee email/checkout + spoken title truncation."""
from __future__ import annotations

from app.email.deliverability import build_payment_email_bodies, validate_payment_email_content
from app.payment.drop_shipping_fee import (
    CUSTOMER_LABEL,
    append_fee_to_draft_line_items,
    checkout_email_lines,
    compute_drop_shipping_fee,
)
from app.voice.title_speech import spoken_book_title


class TestDropShippingFee:
    def test_fee_is_three_percent(self):
        lines = [
            {"title": "Book A", "quantity": 1, "price": "8.50"},
            {"title": "Book B", "quantity": 2, "price": "10.99"},
        ]
        assert compute_drop_shipping_fee(lines) == 0.91

    def test_draft_line_items_include_fee(self):
        books = [{"variant_id": "v1", "quantity": 1, "price": "10.00"}]
        draft = [{"variantId": "v1", "quantity": 1}]
        out = append_fee_to_draft_line_items(draft, books)
        assert len(out) == 2
        assert out[-1]["title"] == CUSTOMER_LABEL
        assert out[-1]["originalUnitPrice"] == "0.30"

    def test_email_lines_include_fee_and_subtotal(self):
        lines = checkout_email_lines(
            [{"title": "Book A", "quantity": 1, "price": "8.50"}]
        )
        assert len(lines) == 2
        assert lines[-1]["title"] == CUSTOMER_LABEL
        _, plain, html = build_payment_email_bodies(
            "https://pay.example.com/x",
            order_lines=lines,
        )
        assert CUSTOMER_LABEL in html
        assert "0.26" in html or "$0.26" in html
        assert "processing fee" not in plain.lower()
        assert "processing fee" not in html.lower()

    def test_validate_allows_drop_shipping_fee(self):
        report = validate_payment_email_content(
            subject="Your SureShot Books payment link",
            plain_body=f"Your order includes a {CUSTOMER_LABEL} of $0.91. SureShot Books",
            from_email="noreply@sureshotbooks.com",
        )
        assert "processing_fee_in_email" not in report.issues


class TestSpokenBookTitle:
    def test_short_title_unchanged(self):
        assert spoken_book_title("The Great Gatsby") == "The Great Gatsby"

    def test_long_title_truncated(self):
        title = "A Clash of Kings: A Song of Ice and Fire: Book Two"
        assert spoken_book_title(title) == "A Clash of"
