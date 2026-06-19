"""
Resend transactional email client.

TODO (Milestone 5 — tool wiring):
    Wire up when USE_REAL_EMAIL=true in send_payment_link and
    send_facility_payment_link tools.

Interface (to implement):
    async def send_email(
        to: str,
        subject: str,
        html: str,
        api_key: str,
        from_email: str,
    ) -> bool:
        '''POST to https://api.resend.com/emails. Returns True on 200.'''

    def payment_link_html(
        checkout_url: str,
        product_name: str,
        amount: str,
        facility_note: str = "",
    ) -> str:
        '''Return the HTML body for a payment link email.'''

Notes:
    - Use httpx.AsyncClient with a 5s timeout.
    - Log the Resend message ID on success (do NOT log the full email body).
    - On 4xx/5xx, log the error and return False — never raise to caller.
    - This module will subsume app/ai/common/notifications.py once activated.
"""
from __future__ import annotations
