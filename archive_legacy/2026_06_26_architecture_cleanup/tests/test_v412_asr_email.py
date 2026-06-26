"""
v4.1.2 tests — ASR email normalization improvements and multi-turn fragment accumulator.

Covers:
 - "activate" → "@" (Twilio STT artifact)
 - "at the rate" → "@"
 - "add" before domain → "@"
 - "g a m i l" / "gamil" → "gmail"
 - "dot c o m" (space-separated TLD) → ".com"
 - "period" → "."
 - Accidental leading single letter → low confidence
 - Multi-turn fragment: "bashisultan766@gmail" + "dot com"
 - Router detects "activate g mail dot com" as email_provided
 - Router does NOT classify "at the facility" as email_provided
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


# ── normalize_spoken_email: AT variants ──────────────────────────────────────

class TestATVariants:
    def test_activate_as_at(self):
        from app.email.capture import normalize_spoken_email
        result = normalize_spoken_email("bashi sultan 7 6 6 activate g mail dot com")
        assert result == "bashisultan766@gmail.com"

    def test_at_the_rate(self):
        from app.email.capture import normalize_spoken_email
        result = normalize_spoken_email("b a s h i s u l t a n 7 6 6 at the rate gmail dot com")
        assert result == "bashisultan766@gmail.com"

    def test_at_rate(self):
        from app.email.capture import normalize_spoken_email
        result = normalize_spoken_email("alice at rate gmail dot com")
        assert result == "alice@gmail.com"

    def test_add_before_domain(self):
        from app.email.capture import normalize_spoken_email
        result = normalize_spoken_email("bob add gmail dot com")
        assert result == "bob@gmail.com"

    def test_period_as_dot(self):
        from app.email.capture import normalize_spoken_email
        result = normalize_spoken_email("alice at outlook period com")
        assert result == "alice@outlook.com"


# ── normalize_spoken_email: domain misspellings ───────────────────────────────

class TestDomainMisspellings:
    def test_gamil_to_gmail(self):
        from app.email.capture import normalize_spoken_email
        result = normalize_spoken_email("alice at gamil dot com")
        assert result == "alice@gmail.com"

    def test_g_a_m_i_l_to_gmail(self):
        # "g a m i l" → space removal → "gamil" → fixed to "gmail"
        from app.email.capture import normalize_spoken_email
        result = normalize_spoken_email("alice at g a m i l dot com")
        assert result == "alice@gmail.com"

    def test_g_mail_with_space_to_gmail(self):
        # "g mail" → space removal → "gmail"
        from app.email.capture import normalize_spoken_email
        result = normalize_spoken_email("alice at g mail dot com")
        assert result == "alice@gmail.com"

    def test_space_separated_tld_letters(self):
        # "dot c o m" → "." + space removal → ".com"
        from app.email.capture import normalize_spoken_email
        result = normalize_spoken_email("alice at gmail dot c o m")
        assert result == "alice@gmail.com"


# ── Prefix artifact detection ─────────────────────────────────────────────────

class TestPrefixArtifact:
    def test_no_artifact_all_lowercase_spelling(self):
        from app.email.capture import _has_prefix_artifact
        # All lowercase single-char tokens → normal spelling, no artifact
        assert _has_prefix_artifact("b a s h i s u l t a n at gmail dot com") is False

    def test_detects_uppercase_leading_artifact(self):
        # Real Twilio STT: STT capitalises the stray leading letter
        from app.email.capture import _has_prefix_artifact
        assert _has_prefix_artifact("P b a s h i s u l t a n at gmail dot com") is True

    def test_typed_email_no_artifact(self):
        from app.email.capture import _has_prefix_artifact
        assert _has_prefix_artifact("alice@gmail.com") is False

    def test_uppercase_artifact_lowers_confidence(self):
        from app.email.capture import normalize_spoken_email, email_confidence
        # Real STT output: capital P before spelled-out local part
        raw = "P b a s h i at gmail dot com"
        email = normalize_spoken_email(raw)
        conf = email_confidence(email, raw)
        assert conf == "low", f"Expected low, got {conf!r} for {raw!r} → {email!r}"

    def test_normal_spelling_high_confidence(self):
        from app.email.capture import normalize_spoken_email, email_confidence
        raw = "b a s h i at gmail dot com"
        email = normalize_spoken_email(raw)
        conf = email_confidence(email, raw)
        assert conf in ("high", "medium")


# ── Domain suffix fragment helpers ────────────────────────────────────────────

class TestDomainSuffixOnly:
    def test_dot_com(self):
        from app.email.capture import is_domain_suffix_only
        assert is_domain_suffix_only("dot com") is True

    def test_dot_net(self):
        from app.email.capture import is_domain_suffix_only
        assert is_domain_suffix_only("dot net") is True

    def test_period_com(self):
        from app.email.capture import is_domain_suffix_only
        assert is_domain_suffix_only("period com") is True

    def test_full_email_not_suffix(self):
        from app.email.capture import is_domain_suffix_only
        assert is_domain_suffix_only("alice at gmail dot com") is False

    def test_random_text_not_suffix(self):
        from app.email.capture import is_domain_suffix_only
        assert is_domain_suffix_only("what is the price") is False


# ── Multi-turn fragment assembler ─────────────────────────────────────────────

class TestFragmentAssembler:
    def test_assemble_local_and_dotcom(self):
        from app.email.capture import assemble_email_from_fragments
        result = assemble_email_from_fragments([
            "bashisultan766 at gmail",
            "dot com",
        ])
        assert result == "bashisultan766@gmail.com"

    def test_assemble_three_parts(self):
        from app.email.capture import assemble_email_from_fragments
        result = assemble_email_from_fragments([
            "alice",
            "at outlook",
            "dot com",
        ])
        assert result == "alice@outlook.com"

    def test_empty_fragments_returns_none(self):
        from app.email.capture import assemble_email_from_fragments
        assert assemble_email_from_fragments([]) is None


# ── Router: spoken email intent detection ────────────────────────────────────

class TestRouterSpokenEmail:
    def test_activate_variant_detected(self):
        from app.pipeline.router import detect
        r = detect("bashisultan766 activate g mail dot com")
        assert r.intent == "email_provided"
        assert r.entities.get("email") == "bashisultan766@gmail.com"

    def test_at_the_rate_detected(self):
        from app.pipeline.router import detect
        r = detect("bashisultan766 at the rate gmail dot com")
        assert r.intent == "email_provided"
        assert r.entities.get("email") == "bashisultan766@gmail.com"

    def test_typed_email_detected(self):
        from app.pipeline.router import detect
        r = detect("bashisultan766@gmail.com")
        assert r.intent == "email_provided"
        assert r.entities.get("email") == "bashisultan766@gmail.com"

    def test_dot_com_suffix_detected(self):
        from app.pipeline.router import detect
        r = detect("dot com")
        assert r.intent == "email_provided"
        # No normalized email from "dot com" alone — raw stored
        assert r.entities.get("email_raw") == "dot com"

    def test_gamil_in_email_detected(self):
        from app.pipeline.router import detect
        r = detect("alice at gamil dot com")
        assert r.intent == "email_provided"
        assert r.entities.get("email") == "alice@gmail.com"

    def test_facility_not_email(self):
        from app.pipeline.router import detect
        r = detect("What are the book restrictions at the facility?")
        assert r.intent != "email_provided"

    def test_at_the_facility_not_email(self):
        from app.pipeline.router import detect
        r = detect("Does the facility at Rikers Island approve books?")
        assert r.intent != "email_provided"


# ── Engine: multi-turn fragment accumulation ─────────────────────────────────

class TestEngineFragmentAccumulation:
    def _make_session(self):
        from app.state.models import SessionState
        return SessionState(
            session_id="s", call_sid="CA42",
            from_number="+1", to_number="+2",
        )

    def test_fragment_stored_when_no_complete_email(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        session = self._make_session()
        # email_raw only, no normalized email
        intent = IntentResult(
            intent="email_provided", confidence=0.85,
            entities={"email_raw": "bashisultan766 at gmail"},
        )
        _apply_email_state(session, intent)
        assert session.pending_email == ""
        assert len(session.pending_email_fragments) == 1

    def test_dot_com_assembles_and_sets_pending(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        session = self._make_session()
        # First turn: partial email
        _apply_email_state(session, IntentResult(
            intent="email_provided", confidence=0.85,
            entities={"email_raw": "bashisultan766 at gmail"},
        ))
        assert len(session.pending_email_fragments) == 1
        # Second turn: "dot com" completion
        _apply_email_state(session, IntentResult(
            intent="email_provided", confidence=0.85,
            entities={"email_raw": "dot com"},
        ))
        assert session.pending_email == "bashisultan766@gmail.com"
        assert len(session.pending_email_fragments) == 0

    def test_correction_clears_fragments(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        session = self._make_session()
        session.pending_email_fragments = ["bashisultan766 at gmail"]
        _apply_email_state(session, IntentResult(
            intent="email_correction", confidence=0.9, entities={},
        ))
        assert session.pending_email_fragments == []
