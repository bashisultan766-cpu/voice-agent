"""Tests for Resend payment link email sender."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


class TestSendPaymentLinkEmail:
    async def test_successful_send(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_resp)

        with (
            patch("app.tools.email_sender.get_settings") as mock_settings,
            patch("app.tools.email_sender.httpx.AsyncClient", return_value=mock_client),
        ):
            mock_settings.return_value.RESEND_API_KEY = "re_test_key"
            mock_settings.return_value.RESEND_FROM_EMAIL = "noreply@example.com"
            mock_settings.return_value.RESEND_FROM_NAME = "Bookstore"
            mock_settings.return_value.SUPPORT_EMAIL = ""

            from app.tools.email_sender import send_payment_link_email

            result = await send_payment_link_email(
                email="customer@example.com",
                checkout_url="https://shop.example.com/pay/123",
                product_summary="The Great Gatsby",
            )

        assert result["success"] is True
        assert "customer@example.com" in result["message"]

    async def test_invalid_email_rejected(self):
        from app.tools.email_sender import send_payment_link_email

        result = await send_payment_link_email(
            email="not-an-email",
            checkout_url="https://example.com/pay/1",
            product_summary="A Book",
        )
        assert result["success"] is False
        assert "email" in result["error"].lower() or "Invalid" in result["error"]

    async def test_missing_resend_key_returns_fallback(self):
        with patch("app.tools.email_sender.get_settings") as mock_settings:
            mock_settings.return_value.RESEND_API_KEY = ""
            mock_settings.return_value.RESEND_FROM_EMAIL = "noreply@example.com"
            mock_settings.return_value.RESEND_FROM_NAME = "Bookstore"
            mock_settings.return_value.SUPPORT_EMAIL = ""

            from app.tools.email_sender import send_payment_link_email

            result = await send_payment_link_email(
                email="customer@example.com",
                checkout_url="https://shop.example.com/pay/123",
                product_summary="A Book",
            )

        assert result["success"] is False
        assert "fallback_message" in result
        assert "https://shop.example.com/pay/123" in result["fallback_message"]

    async def test_resend_api_error_returns_failure(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 422
        mock_resp.json.return_value = {"message": "Invalid from address"}
        mock_resp.text = "Invalid from address"

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_resp)

        with (
            patch("app.tools.email_sender.get_settings") as mock_settings,
            patch("app.tools.email_sender.httpx.AsyncClient", return_value=mock_client),
        ):
            mock_settings.return_value.RESEND_API_KEY = "re_test_key"
            mock_settings.return_value.RESEND_FROM_EMAIL = "bad@"
            mock_settings.return_value.RESEND_FROM_NAME = ""
            mock_settings.return_value.SUPPORT_EMAIL = ""

            from app.tools.email_sender import send_payment_link_email

            result = await send_payment_link_email(
                email="customer@example.com",
                checkout_url="https://shop.example.com/pay/1",
                product_summary="Book",
            )

        assert result["success"] is False

    async def test_api_key_not_logged(self, caplog):
        import logging

        mock_resp = MagicMock()
        mock_resp.status_code = 200

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_resp)

        secret_key = "re_SUPERSECRET_DO_NOT_LOG"

        with (
            patch("app.tools.email_sender.get_settings") as mock_settings,
            patch("app.tools.email_sender.httpx.AsyncClient", return_value=mock_client),
            caplog.at_level(logging.DEBUG),
        ):
            mock_settings.return_value.RESEND_API_KEY = secret_key
            mock_settings.return_value.RESEND_FROM_EMAIL = "noreply@example.com"
            mock_settings.return_value.RESEND_FROM_NAME = "Bookstore"
            mock_settings.return_value.SUPPORT_EMAIL = ""

            from app.tools.email_sender import send_payment_link_email

            await send_payment_link_email(
                email="customer@example.com",
                checkout_url="https://shop.example.com/pay/1",
                product_summary="A Book",
            )

        assert secret_key not in caplog.text

    async def test_empty_checkout_url_rejected(self):
        from app.tools.email_sender import send_payment_link_email

        with patch("app.tools.email_sender.get_settings") as mock_settings:
            mock_settings.return_value.RESEND_API_KEY = "re_key"
            mock_settings.return_value.RESEND_FROM_EMAIL = "n@e.com"
            mock_settings.return_value.RESEND_FROM_NAME = ""
            mock_settings.return_value.SUPPORT_EMAIL = ""

            result = await send_payment_link_email(
                email="customer@example.com",
                checkout_url="",
                product_summary="A Book",
            )

        assert result["success"] is False
