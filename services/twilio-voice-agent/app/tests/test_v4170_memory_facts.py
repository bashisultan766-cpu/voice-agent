"""Tests for durable memory fact extraction (v4.17)."""
from __future__ import annotations

import asyncio
import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.state.models import SessionState
from app.conversation.call_memory import (
    extract_durable_facts,
    extract_turn_facts,
    get_call_memory,
    build_memory_snapshot,
    persist_call_memory,
    load_call_memory_snapshot,
)
from app.agent_runtime.call_memory_manager import CallMemoryManager


def _session(sid="CA_MEM0001") -> SessionState:
    return SessionState(
        session_id="s-mem",
        call_sid=sid,
        from_number="+15550001212",
        to_number="+18005551234",
    )


def _facts(session) -> list[str]:
    return get_call_memory(session).important_facts


class TestDurableFactExtraction:
    def test_memory_facts_extracted_after_name_email_isbn(self):
        session = _session()
        extract_durable_facts(session, "Hi, my name is Berlin")
        extract_durable_facts(session, "My email is berlin@example.com")
        extract_durable_facts(session, "The ISBN is 9 7 8 0 9 9 7 3 6 1 3 0 8")
        facts = _facts(session)
        joined = " | ".join(facts)
        assert any("Caller name: Berlin" in f for f in facts)
        assert any("email" in f.lower() for f in facts)
        # The raw email must never appear in a stored fact.
        assert "berlin@example.com" not in joined
        # ISBN remembered (validated, full 13 digits).
        assert "9780997361308" in get_call_memory(session).isbns_provided
        assert len(facts) > 0

    def test_quantity_and_order_facts(self):
        session = _session("CA_MEM0002")
        extract_durable_facts(session, "I need two copies")
        extract_durable_facts(session, "My order number is 1042")
        facts = _facts(session)
        assert any("Quantity: 2" in f for f in facts)
        assert any("1042" in f for f in facts)

    def test_facility_and_payment_facts(self):
        session = _session("CA_MEM0003")
        extract_durable_facts(session, "This is for an inmate at the facility")
        extract_durable_facts(session, "Can you send me the payment link")
        facts = _facts(session)
        assert any("Facility" in f for f in facts)
        assert any("Payment link" in f for f in facts)

    def test_name_stopwords_not_captured(self):
        session = _session("CA_MEM0004")
        extract_durable_facts(session, "I am looking for a book")
        facts = _facts(session)
        assert not any("Caller name: Looking" in f for f in facts)

    def test_packet_facts_gt_zero_after_meaningful_turns(self):
        session = _session("CA_MEM0005")
        CallMemoryManager.update_after_turn(
            session, "Hi, my name is Berlin and I need two copies", "Hi Berlin!", intent="small_talk"
        )
        packet = CallMemoryManager.build_packet(session)
        assert len(packet.facts) > 0


class TestSnapshotPersistence:
    def test_snapshot_roundtrip(self):
        session = _session("CA_MEM0006")
        extract_turn_facts(session, "small_talk", "my name is Berlin")
        snap = build_memory_snapshot(session)
        assert snap["facts_count"] >= 1
        assert snap["caller_name"] == "Berlin"

        async def _roundtrip():
            await persist_call_memory(session)
            return await load_call_memory_snapshot("CA_MEM0006")

        loaded = asyncio.run(_roundtrip())
        assert loaded is not None
        assert loaded["facts_count"] >= 1

    def test_inspect_cli_importable(self):
        from app.scripts import inspect_call_memory

        assert callable(inspect_call_memory.main)
