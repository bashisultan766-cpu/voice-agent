"""v4.16.0 — Read-only scout tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


@pytest.mark.asyncio
class TestScouts:
    async def test_conversation_scout_greeting(self):
        from app.agent_runtime.scouts.conversation_scout import run_scout

        result = await run_scout(user_text="Hello. How are you, brother?")
        assert result is not None
        assert result.kind == "conversation_signal"
        assert result.facts.get("is_greeting") is True

    async def test_isbn_scout(self):
        from app.agent_runtime.scouts.isbn_scout import run_scout

        result = await run_scout(user_text="ISBN 978-0-441-17271-9")
        assert result is not None
        assert result.kind == "isbn_candidate"
        assert result.entities["isbn"]

    async def test_publication_scout_usa_today(self):
        from app.agent_runtime.scouts.publication_scout import run_scout

        result = await run_scout(user_text="USA Today 5 day delivery 3 months")
        assert result is not None
        assert result.kind == "publication_candidate"
        assert result.entities["product_kind"] in ("newspaper", "subscription")

    async def test_publication_scout_magazine(self):
        from app.agent_runtime.scouts.publication_scout import run_scout

        result = await run_scout(user_text="People magazine subscription")
        assert result is not None
        assert result.entities["product_kind"] == "magazine"

    async def test_domain_scout_out_of_domain(self):
        from app.agent_runtime.scouts.domain_scout import run_scout

        result = await run_scout(user_text="How do I make tea?")
        assert result is not None
        assert result.entities["domain_status"] == "out_of_domain"

    async def test_scouts_do_not_mutate_cart(self):
        from app.agent_runtime.commerce_session import get_commerce_session
        from app.agent_runtime.scouts.catalog_scout import run_scout

        commerce = get_commerce_session("CAscout1")
        before = len(commerce.active_cart)
        await run_scout(user_text="Do you have books about cricket?", commerce_session=commerce)
        after = len(commerce.active_cart)
        assert before == after
