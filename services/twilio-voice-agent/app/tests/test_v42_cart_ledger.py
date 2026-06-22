"""
v4.2 tests — CartLedger multi-book cart.

Verifies that books are never lost when a new book is added,
and confirmation/rejection work correctly.
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.cart.ledger import CartItem, CartLedger


class TestCartLedgerBasics:
    def test_empty_cart(self):
        cart = CartLedger()
        assert cart.count() == 0
        assert cart.confirmed_count() == 0

    def test_add_candidate(self):
        cart = CartLedger()
        cart.add_candidate(CartItem(title="Dune", isbn="9780441172719"))
        assert cart.count() == 1
        assert cart.candidate_item.title == "Dune"

    def test_confirm_candidate(self):
        cart = CartLedger()
        cart.add_candidate(CartItem(title="Dune", isbn="9780441172719"))
        item = cart.confirm_last_candidate()
        assert item.title == "Dune"
        assert item.confirmation_status == "confirmed"
        assert cart.confirmed_count() == 1

    def test_reject_candidate(self):
        cart = CartLedger()
        cart.add_candidate(CartItem(title="Dune"))
        cart.reject_last_candidate()
        assert cart.confirmed_count() == 0
        assert cart.count() == 0  # rejected items excluded from count

    def test_two_books_both_retained(self):
        cart = CartLedger()
        cart.add_candidate(CartItem(title="Dune", isbn="9780441172719"))
        cart.confirm_last_candidate()
        cart.add_candidate(CartItem(title="1984", isbn="9780451524935"))
        cart.confirm_last_candidate()
        assert cart.confirmed_count() == 2

    def test_another_book_doesnt_remove_first(self):
        cart = CartLedger()
        cart.add_candidate(CartItem(title="Dune", isbn="9780441172719"))
        cart.confirm_last_candidate()
        # Now caller wants another book
        cart.add_candidate(CartItem(title="Foundation", isbn="9780553293357"))
        # Dune must still be there
        assert cart.confirmed_count() == 1
        titles = cart.titles(confirmed_only=True)
        assert "Dune" in titles

    def test_titles_returns_ordered_list(self):
        cart = CartLedger()
        cart.add_candidate(CartItem(title="Dune"))
        cart.confirm_last_candidate()
        cart.add_candidate(CartItem(title="1984"))
        cart.confirm_last_candidate()
        cart.add_candidate(CartItem(title="Foundation"))
        cart.confirm_last_candidate()
        titles = cart.titles(confirmed_only=True)
        assert titles == ["Dune", "1984", "Foundation"]

    def test_update_quantity(self):
        cart = CartLedger()
        cart.add_candidate(CartItem(title="Dune", isbn="9780441172719"))
        cart.confirm_last_candidate()
        cart.update_quantity("9780441172719", 3)
        assert cart.confirmed_items[0].quantity == 3

    def test_duplicate_isbn_updates_existing(self):
        cart = CartLedger()
        cart.add_candidate(CartItem(title="Dune", isbn="9780441172719"))
        cart.confirm_last_candidate()
        # Add same ISBN again
        cart.add_candidate(CartItem(title="Dune (updated)", isbn="9780441172719",
                                    variant_id="gid://123"))
        # Should update existing, not add duplicate
        active = [i for i in cart.items if i.confirmation_status != "rejected"]
        assert len(active) == 1

    def test_to_checkout_items(self):
        cart = CartLedger()
        cart.add_candidate(CartItem(
            title="Dune", isbn="9780441172719",
            variant_id="gid://shopify/ProductVariant/123", quantity=2,
        ))
        cart.confirm_last_candidate()
        items = cart.to_checkout_items()
        assert len(items) == 1
        assert items[0]["variant_id"] == "gid://shopify/ProductVariant/123"
        assert items[0]["quantity"] == 2

    def test_to_session_format(self):
        cart = CartLedger()
        cart.add_candidate(CartItem(title="Dune", isbn="9780441172719", price="15.99"))
        cart.confirm_last_candidate()
        fmt = cart.to_session_format()
        assert len(fmt) == 1
        assert fmt[0]["title"] == "Dune"
        assert fmt[0]["price"] == "15.99"
        assert fmt[0]["confirmation_status"] == "confirmed"
