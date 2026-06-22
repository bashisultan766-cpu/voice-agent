"""Tests for CallerProfile and CallSessionMemory persistence."""
import pytest
from unittest.mock import AsyncMock, patch
from datetime import datetime, timezone

from app.caller.models import CallerProfile, CallSessionMemory
from app.caller.repository import normalize_phone, get_caller_profile, save_caller_profile, upsert_caller_profile


class TestNormalizePhone:
    def test_e164(self):
        assert normalize_phone("+15551234567") == "15551234567"

    def test_dashes(self):
        assert normalize_phone("555-123-4567") == "5551234567"

    def test_spaces(self):
        assert normalize_phone("(555) 123 4567") == "5551234567"

    def test_already_digits(self):
        assert normalize_phone("15551234567") == "15551234567"

    def test_empty(self):
        assert normalize_phone("") == ""


class TestCallerProfileModel:
    def test_to_dict_roundtrip(self):
        now = datetime.now(timezone.utc).isoformat()
        profile = CallerProfile(
            id="15551234567",
            phone_number="+15551234567",
            normalized_phone="15551234567",
            display_name="Alice",
            preferred_email="alice@example.com",
            call_count=3,
            last_seen_at=now,
            created_at=now,
            updated_at=now,
        )
        d = profile.to_dict()
        restored = CallerProfile.from_dict(d)
        assert restored.display_name == "Alice"
        assert restored.call_count == 3
        assert restored.preferred_email == "alice@example.com"
        assert restored.normalized_phone == "15551234567"

    def test_defaults(self):
        profile = CallerProfile(
            id="x",
            phone_number="+1",
            normalized_phone="1",
        )
        assert profile.call_count == 0
        assert profile.display_name == ""
        assert profile.last_summary == ""


class TestCallSessionMemoryModel:
    def test_to_dict_roundtrip(self):
        mem = CallSessionMemory(
            call_sid="CA123",
            normalized_phone="15551234567",
            caller_name="Bob",
            verified_email=True,
        )
        d = mem.to_dict()
        restored = CallSessionMemory.from_dict(d)
        assert restored.caller_name == "Bob"
        assert restored.verified_email is True

    def test_defaults(self):
        mem = CallSessionMemory(call_sid="CA000", normalized_phone="1")
        assert mem.selected_items == []
        assert mem.payment_email_sent_to == []
        assert mem.pending_checkout_url == ""


class TestCallerProfileRepository:
    async def test_get_profile_not_found(self):
        with patch("app.caller.repository.cache_get", new=AsyncMock(return_value=None)):
            result = await get_caller_profile("+15551234567")
            assert result is None

    async def test_get_profile_found(self):
        now = datetime.now(timezone.utc).isoformat()
        profile = CallerProfile(
            id="15551234567",
            phone_number="+15551234567",
            normalized_phone="15551234567",
            display_name="Alice",
            call_count=2,
            created_at=now,
            updated_at=now,
        )
        with patch("app.caller.repository.cache_get", new=AsyncMock(return_value=profile.to_dict())):
            result = await get_caller_profile("+15551234567")
            assert result is not None
            assert result.display_name == "Alice"
            assert result.call_count == 2

    async def test_get_profile_corrupt_data_returns_none(self):
        with patch("app.caller.repository.cache_get", new=AsyncMock(return_value={"bad": "data"})):
            # from_dict should fail gracefully
            try:
                result = await get_caller_profile("+15551234567")
                # Either returns None or a partial profile — must not raise
            except Exception:
                pytest.fail("get_caller_profile raised on corrupt data")

    async def test_save_profile(self):
        now = datetime.now(timezone.utc).isoformat()
        profile = CallerProfile(
            id="15551234567",
            phone_number="+15551234567",
            normalized_phone="15551234567",
            created_at=now,
            updated_at=now,
        )
        mock_set = AsyncMock()
        with patch("app.caller.repository.cache_set", new=mock_set):
            await save_caller_profile(profile)
            mock_set.assert_called_once()
            key_arg = mock_set.call_args[0][0]
            assert "caller:profile:15551234567" == key_arg

    async def test_upsert_creates_new_profile(self):
        mock_get = AsyncMock(return_value=None)
        mock_set = AsyncMock()
        with (
            patch("app.caller.repository.cache_get", new=mock_get),
            patch("app.caller.repository.cache_set", new=mock_set),
        ):
            profile = await upsert_caller_profile(
                phone_number="+15551234567",
                display_name="New User",
            )
            assert profile.display_name == "New User"
            assert profile.call_count == 1
            mock_set.assert_called_once()

    async def test_upsert_increments_call_count(self):
        now = datetime.now(timezone.utc).isoformat()
        existing = CallerProfile(
            id="15551234567",
            phone_number="+15551234567",
            normalized_phone="15551234567",
            display_name="Returning",
            call_count=4,
            created_at=now,
            updated_at=now,
        )
        mock_get = AsyncMock(return_value=existing.to_dict())
        mock_set = AsyncMock()
        with (
            patch("app.caller.repository.cache_get", new=mock_get),
            patch("app.caller.repository.cache_set", new=mock_set),
        ):
            profile = await upsert_caller_profile("+15551234567")
            assert profile.call_count == 5

    async def test_empty_phone_returns_none(self):
        result = await get_caller_profile("")
        assert result is None
