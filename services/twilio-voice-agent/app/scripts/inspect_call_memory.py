#!/usr/bin/env python3
"""
Inspect persisted call memory for a given Call SID. Safe — no raw PII printed.

Usage:
    python -m app.scripts.inspect_call_memory --sid <CALL_SID>

Reads the working-memory snapshot (caller:memory:{sid}) and the per-call
scratch-pad (caller:session:{sid}) from Redis / in-memory store.
"""
from __future__ import annotations

import argparse
import asyncio
import sys


def _print_section(title: str) -> None:
    print()
    print(title)
    print("-" * len(title))


async def _run(sid: str) -> int:
    from app.conversation.call_memory import load_call_memory_snapshot
    from app.caller.repository import get_session_memory

    print(f"Call memory inspection for SID: {sid[:10]}***")
    print("=" * 44)

    snapshot = await load_call_memory_snapshot(sid)
    found = False

    if snapshot:
        found = True
        _print_section("Working memory")
        print(f"Turns (user):      {snapshot.get('turn_count', 0)}")
        print(f"Turns (assistant): {snapshot.get('assistant_turns', 0)}")
        print(f"Facts count:       {snapshot.get('facts_count', 0)}")
        print(f"Email state:       {snapshot.get('email_state', 'none')}")
        print(f"Payment status:    {snapshot.get('payment_flow_status', 'idle')}")
        print(f"Topic:             {snapshot.get('current_topic', '')}")
        print(f"Mood:              {snapshot.get('customer_mood', 'normal')}")
        isbns = snapshot.get("isbns") or []
        if isbns:
            print(f"ISBNs:             {', '.join(isbns)}")
        facts = snapshot.get("facts") or []
        if facts:
            _print_section("Durable facts")
            for f in facts:
                print(f"  - {f}")
    else:
        _print_section("Working memory")
        print("(no working-memory snapshot found for this SID)")

    session_mem = await get_session_memory(sid)
    if session_mem:
        found = True
        _print_section("Session scratch-pad")
        print(f"Caller name:       {session_mem.caller_name or '(none)'}")
        print(f"Current intent:    {session_mem.current_intent or '(none)'}")
        print(f"Last order:        {session_mem.last_order_number or '(none)'}")
        print(f"Last product query:{session_mem.last_product_query or '(none)'}")
        print(f"Selected items:    {len(session_mem.selected_items)}")
        print(f"Verified email:    {session_mem.verified_email}")
        print(f"Verified phone:    {session_mem.verified_phone}")

    print()
    print("=" * 44)
    print("No secrets, API keys, or raw PII printed.")
    if not found:
        print("No memory found for this SID (it may have expired or never existed).")
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Inspect persisted call memory.")
    parser.add_argument("--sid", required=True, help="Twilio Call SID")
    args = parser.parse_args(argv)
    if not args.sid:
        print("error: --sid is required", file=sys.stderr)
        return 2
    return asyncio.run(_run(args.sid))


if __name__ == "__main__":
    raise SystemExit(main())
