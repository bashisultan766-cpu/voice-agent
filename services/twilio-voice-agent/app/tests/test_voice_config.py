"""ElevenLabs / ConversationRelay voice config parity with order-lookup-voice-agent."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.config import Settings, get_settings
from app.voice.voice_config import (
    AudioChunkAccumulator,
    format_twilio_voice_tuning,
    get_elevenlabs_voice_settings,
    normalize_twilio_elevenlabs_model,
    resolve_telephony_output_format,
    telephony_chunk_bounds,
)


class TestNormalizeTwilioElevenLabsModel:
    def test_maps_eleven_turbo_v2_5(self):
        assert normalize_twilio_elevenlabs_model("eleven_turbo_v2_5") == "turbo_v2_5"

    def test_maps_eleven_flash_v2_5(self):
        assert normalize_twilio_elevenlabs_model("eleven_flash_v2_5") == "flash_v2_5"

    def test_passes_through_twilio_slug(self):
        assert normalize_twilio_elevenlabs_model("flash_v2_5") == "flash_v2_5"


class TestFormatTwilioVoiceTuning:
    def test_formats_integer_speed_as_one_decimal(self):
        assert format_twilio_voice_tuning(1, 0.55, 0.8) == "1.0_0.55_0.8"

    def test_preserves_existing_decimals(self):
        assert format_twilio_voice_tuning(0.92, 0.7, 0.85) == "0.92_0.7_0.85"


class TestEnterpriseVoiceSettings:
    def test_defaults_match_node_service(self):
        settings = get_elevenlabs_voice_settings()
        assert settings == {
            "stability": 0.70,
            "similarity_boost": 0.85,
            "style": 0.0,
            "use_speaker_boost": True,
        }

    def test_config_defaults_match_node(self):
        s = Settings(OPENAI_API_KEY="test", DEBUG=True)
        assert s.VOICE_MODEL == "eleven_turbo_v2_5"
        assert s.VOICE_SPEED == 0.92
        assert s.VOICE_STABILITY == 0.70
        assert s.VOICE_SIMILARITY == 0.85
        assert s.VOICE_STYLE == 0.0
        assert s.TTS_AUDIO_FORMAT == "ulaw_8000"
        assert s.VOICE_TUNING_ENABLED is True


class TestBuildConversationRelayVoice:
    def test_builds_with_tuning_suffix(self):
        s = Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            VOICE_TTS_PROVIDER="ElevenLabs",
            VOICE_ID="voice123",
            VOICE_MODEL="turbo_v2_5",
            VOICE_TUNING_ENABLED=True,
        )
        assert s.build_conversation_relay_voice() == "voice123-turbo_v2_5-0.92_0.7_0.85"

    def test_strips_eleven_prefix_from_model(self):
        s = Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            VOICE_TTS_PROVIDER="ElevenLabs",
            VOICE_ID="cjVigY5qzO86Huf0OWal",
            VOICE_MODEL="eleven_flash_v2_5",
            VOICE_TUNING_ENABLED=False,
        )
        assert s.build_conversation_relay_voice() == "cjVigY5qzO86Huf0OWal-flash_v2_5"

    def test_custom_tuning(self):
        s = Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            VOICE_TTS_PROVIDER="ElevenLabs",
            VOICE_ID="voice123",
            VOICE_MODEL="flash_v2_5",
            VOICE_SPEED=1.0,
            VOICE_STABILITY=0.55,
            VOICE_SIMILARITY=0.8,
            VOICE_TUNING_ENABLED=True,
        )
        assert s.build_conversation_relay_voice() == "voice123-flash_v2_5-1.0_0.55_0.8"

    def test_google_fallback_without_voice_id(self):
        s = Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            VOICE_TTS_PROVIDER="ElevenLabs",
            VOICE_ID="",
        )
        assert s.build_conversation_relay_voice() == "Google.en-US-Neural2-J"


class TestTelephonyFormat:
    def test_coerces_mp3_to_ulaw(self):
        assert resolve_telephony_output_format("mp3_44100_128") == "ulaw_8000"

    def test_pcm_16000_preserved(self):
        assert resolve_telephony_output_format("pcm_16000") == "pcm_16000"

    def test_ulaw_chunk_bounds(self):
        assert telephony_chunk_bounds("ulaw_8000") == (160, 400)

    def test_pcm_chunk_bounds(self):
        assert telephony_chunk_bounds("pcm_16000") == (640, 1600)


class TestAudioChunkAccumulator:
    def test_frames_20_to_50_ms_ulaw(self):
        min_b, max_b = telephony_chunk_bounds("ulaw_8000")
        acc = AudioChunkAccumulator(min_b, max_b)
        # 1000 bytes ≈ 125 ms @ 8 kHz — expect multiple max-sized frames + tail
        ready = acc.ingest(bytes(max_b * 2 + min_b))
        assert all(min_b <= len(c) <= max_b for c in ready)


class TestTwimlVoiceAttrs:
    def test_elevenlabs_text_normalization_in_twiml(self):
        from app.api.twilio_voice import _conversation_relay_twiml

        s = Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            PUBLIC_BASE_URL="https://test.example.com",
            VOICE_TTS_PROVIDER="ElevenLabs",
            VOICE_ID="voice123",
            VOICE_MODEL="turbo_v2_5",
            VOICE_TUNING_ENABLED=False,
        )
        xml = _conversation_relay_twiml(
            ws_url="wss://test.example.com/ws",
            call_sid="CA",
            from_number="+1",
            to_number="+2",
            settings=s,
        )
        assert "elevenlabsTextNormalization" in xml
        assert 'elevenlabsTextNormalization="on"' in xml
        assert "voice123-turbo_v2_5" in xml

    def test_tuning_appended_by_default(self):
        from app.api.twilio_voice import _conversation_relay_twiml

        s = Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            PUBLIC_BASE_URL="https://test.example.com",
            VOICE_TTS_PROVIDER="ElevenLabs",
            VOICE_ID="voice123",
            VOICE_MODEL="flash_v2_5",
        )
        xml = _conversation_relay_twiml(
            ws_url="wss://test.example.com/ws",
            call_sid="CA",
            from_number="+1",
            to_number="+2",
            settings=s,
        )
        assert "voice123-flash_v2_5-0.92_0.7_0.85" in xml


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
