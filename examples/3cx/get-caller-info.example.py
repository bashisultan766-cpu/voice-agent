#!/usr/bin/env python3
"""
Python example — query 3CX XAPI directly, then call voice-agent GetCallerInfo.

Install SDK (optional, for direct 3CX access):
  pip install 3cx-xapi-python-sdk httpx

Usage:
  API_BASE=https://agent.mailcallcommunication.com \\
  VOICE_API_KEY=your-key \\
  python examples/3cx/get-caller-info.example.py +12515551234
"""

from __future__ import annotations

import json
import os
import sys

import httpx

API_BASE = os.environ.get("API_BASE", "http://localhost:3001").rstrip("/")
VOICE_API_KEY = os.environ.get("VOICE_API_KEY", "")
PHONE = sys.argv[1] if len(sys.argv) > 1 else "+12515551234"


def get_caller_info_via_backend(phone_number: str) -> dict:
    headers = {"Content-Type": "application/json"}
    if VOICE_API_KEY:
        headers["x-voice-api-key"] = VOICE_API_KEY

    response = httpx.post(
        f"{API_BASE}/api/voice/get-caller-info",
        headers=headers,
        json={"phone_number": phone_number},
        timeout=30.0,
    )
    response.raise_for_status()
    return response.json()


def get_caller_info_via_3cx_sdk(phone_number: str) -> dict | None:
    """Optional — direct 3CX XAPI (requires service principal on PBX)."""
    base_url = os.environ.get("THREE_CX_BASE_URL", "").rstrip("/")
    client_id = os.environ.get("THREE_CX_CLIENT_ID", "")
    client_secret = os.environ.get("THREE_CX_CLIENT_SECRET", "")
    if not (base_url and client_id and client_secret):
        return None

    try:
        from threecx import ThreeCXClient, ODataQuery  # type: ignore
    except ImportError:
        print("Install 3cx-xapi-python-sdk for direct PBX queries: pip install 3cx-xapi-python-sdk")
        return None

    digits = "".join(ch for ch in phone_number if ch.isdigit())
    with ThreeCXClient(base_url=base_url, client_id=client_id, client_secret=client_secret) as client:
        q = ODataQuery().filter(f"contains(PhoneNumber,'{digits}')").top(5)
        contacts = list(client.contacts.list(q))
        history_q = ODataQuery().order_by("SegmentStartTime desc").top(20)
        history = list(client.call_history.iterate(history_q))

    return {
        "contacts_found": len(contacts),
        "history_rows": len(history),
        "note": "Use backend GetCallerInfo for Eric-ready JSON (greeting_hint, recording_urls).",
    }


def main() -> None:
    info = get_caller_info_via_backend(PHONE)
    print("=== Backend GetCallerInfo (Eric tool response) ===")
    print(json.dumps(info, indent=2))

    direct = get_caller_info_via_3cx_sdk(PHONE)
    if direct is not None:
        print("\n=== Direct 3CX SDK probe ===")
        print(json.dumps(direct, indent=2))

    if info.get("should_ask_for_name"):
        print("\nCaller unknown — Eric should ask for name and call SaveCallerName.")


if __name__ == "__main__":
    main()
