"""
Internal backend API client — httpx wrapper for the NestJS agent API.

This client backs all 13 voice tools. Every tool that calls the real backend
(rather than a mock) goes through this module.

TODO (Milestone 5 — tool wiring):
    Implement when AGENT_API_BASE is configured and backend endpoints exist.

Interface (to implement):

    class AgentAPIClient:
        '''
        Async httpx client for {AGENT_API_BASE}.
        Shared session, auto-retry on 5xx, structured error logging.
        '''

        def __init__(self, base_url: str, api_key: str): ...

        async def get_order(self, order_number: str) -> dict: ...
        async def search_catalog(self, query: str, limit: int = 5) -> dict: ...
        async def get_caller_info(self, phone_e164: str) -> dict: ...
        async def save_caller_name(self, phone_e164: str, name: str) -> dict: ...
        async def check_facility_approval(
            self, facility_name: str, state: str
        ) -> dict: ...
        async def check_order_facility_restrictions(
            self, order_number: str, facility_name: str
        ) -> dict: ...
        async def calculate_pricing(
            self, items: list[dict], zip_code: str
        ) -> dict: ...
        async def cancel_order(self, order_number: str) -> dict: ...
        async def escalate(self, call_sid: str, reason: str) -> dict: ...
        async def send_payment_link(self, payload: dict) -> dict: ...
        async def send_facility_payment_link(self, payload: dict) -> dict: ...
        async def get_address_update_instructions(self) -> dict: ...

    def get_agent_api_client(settings: Settings) -> AgentAPIClient:
        '''Factory: returns a cached client instance.'''

Common behaviour:
    - Base URL: Settings.AGENT_API_BASE
    - Auth header: Authorization: Bearer {Settings.AGENT_API_KEY}
    - Timeout: 4s (voice latency budget)
    - Retries: 2 on 5xx with exponential backoff (max 1s)
    - On any unrecoverable error: return {"error": str, "success": false}
      so the tool can return a graceful voice fallback without crashing.

Schema placeholders:
    Each method has a TODO comment pointing to the schema the user will paste.
"""
from __future__ import annotations
