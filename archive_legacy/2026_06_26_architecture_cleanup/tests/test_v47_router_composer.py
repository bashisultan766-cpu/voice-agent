"""v4.7 — live composer prompt and router memory intents."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.ai.system_prompt import build_system_message
from app.pipeline.router import detect
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s-v47", call_sid="CA_V47",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


class TestLiveComposerPrompt:
    def test_no_available_tools(self):
        msg = build_system_message(live_composer=True)
        assert "Available Tools" not in msg["content"]

    def test_no_tool_names(self):
        content = build_system_message(live_composer=True)["content"]
        for name in ("GetOrder", "SendPaymentLink", "SureShotCatalogSearch", "MainLLMComposer"):
            assert name not in content

    def test_has_privacy_rules(self):
        content = build_system_message(live_composer=True)["content"]
        assert "Privacy" in content or "privacy" in content

    def test_backend_worker_rules(self):
        content = build_system_message(live_composer=True)["content"]
        assert "deterministic workers" in content.lower() or "worker context" in content.lower()


class TestMemoryRouterV47:
    def test_first_book_title(self):
        assert detect("What is the first book title?").intent == "first_book_question"

    def test_which_book_add_first(self):
        assert detect("Which book I add first?").intent == "first_book_question"

    def test_greeting_plus_first_book(self):
        r = detect("Hello? What is the first book title name?")
        assert r.intent == "first_book_question"
        assert r.intent != "greeting"
        assert r.intent != "product_search"

    def test_order_phrase_first_book(self):
        r = detect("which book I add first in my order")
        assert r.intent == "first_book_question"
        assert r.intent != "order_lookup"

    def test_explicit_ask_first_book(self):
        assert detect("I am asking you which book I add first").intent == "first_book_question"

    def test_ending_thanks(self):
        assert detect("Okay. Thank you.").intent == "ending_thanks"
        assert detect("Thank you.").intent == "ending_thanks"

    def test_memory_not_product_search(self):
        for phrase in (
            "What is the first book title?",
            "Which book I add first?",
            "Title?",
        ):
            r = detect(phrase, session=_session())
            assert r.intent not in ("product_search", "book_title_search", "author_search")
