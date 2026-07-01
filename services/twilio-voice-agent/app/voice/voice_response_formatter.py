"""
Voice response formatter — normalizes raw LLM / handler text into short,
voice-optimized speech before Twilio TTS.

Transformation only: does not change business logic or workflow state.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable, Literal

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

MAX_SPEECH_CHARS = 240
NextAction = Literal["ask", "answer", "confirm", "close"]

_REASONING_BLOCK_RE = re.compile(
    r"<think(?:ing)?>.*?</think(?:ing)?>",
    re.I | re.S,
)
_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*[\s\S]*?```", re.I)
_JSON_OBJECT_RE = re.compile(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}")
_MARKDOWN_HEADING_RE = re.compile(r"^#{1,6}\s+.+$", re.MULTILINE)
_BULLET_LINE_RE = re.compile(r"^\s*[-*•]\s+.+$", re.MULTILINE)
_KV_DUMP_RE = re.compile(
    r"^\s*[A-Za-z_][\w\s]{0,30}:\s*.+$",
    re.MULTILINE,
)
_INTERNAL_PHRASES: tuple[re.Pattern, ...] = (
    re.compile(r"\b(let me think|i(?:'ll| will) (?:search|look up|check the))\b", re.I),
    re.compile(r"\b(based on (?:the )?tool|according to (?:the )?database)\b", re.I),
    re.compile(r"\b(here(?:'s| is) (?:the )?(?:raw|full|detailed) (?:data|output|json))\b", re.I),
    re.compile(r"\b(as an ai|language model)\b", re.I),
)
_ROBOTIC_TOOL_RE = re.compile(
    r"\b(search_products|lookup_order_status|send_payment_link|get_order)\b",
    re.I,
)
_MAX_IDEA_WORDS = 12
_MONEY_IN_TEXT_RE = re.compile(r"\$\s*([\d,]+(?:\.\d{1,2})?)")
# Internal prosody markers (stripped before TTS): mild (word), medium *word*, strong **word**
_STRONG_EMPHASIS_RE = re.compile(r"\*\*([^*]+)\*\*")
_MEDIUM_EMPHASIS_RE = re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)")
_MILD_EMPHASIS_RE = re.compile(r"\(([^)]+)\)")
_ANY_EMPHASIS_MARKER_RE = re.compile(r"\*\*[^*]+\*\*|\*[^*]+\*|\([^)]+\)")
_EMPHASIS_STRONG: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"\b(failed|failure|error|unable|cannot|couldn't|denied|rejected|problem|critical|urgent)\b",
        re.I,
    ),
)
_EMPHASIS_MEDIUM: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b\d{1,6}\s+dollars\s+and\s+\d{1,2}\s+cents\b", re.I),
    re.compile(r"\$[\d,]+(?:\.\d{1,2})?"),
    re.compile(r"\b\d{1,6}\s+dollars\b(?!\s+and\s+\d)", re.I),
    re.compile(r"\border\s+#?\d{4,}\b", re.I),
    re.compile(r"#\d{4,}\b"),
)
_EMPHASIS_MILD: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"\b(paid|shipped|confirmed|delivered|approved|verified|complete|completed|ready|added)\b",
        re.I,
    ),
)
_SEMANTIC_QUANTITY_RE = re.compile(
    r"\b((?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
    r"fifteen|twenty|thirty|forty|fifty|\d{1,4})\s+(?:copies?|copy))\b",
    re.I,
)
_HOW_MANY_COPIES_RE = re.compile(r"\b(how many copies)\b", re.I)
_FOUND_IT_TITLE_RE = re.compile(
    r"(Found it\s*[—\-]\s*)([^.?!\n]+)([.?!])",
    re.I,
)
_OF_TITLE_RE = re.compile(
    r"(\b(?:one copy|\d+\s+copies?|\d+\s+copy)\s+of\s+)([^.?!\n]+)([.?!])",
    re.I,
)
_COPIES_OF_TITLE_RE = re.compile(
    r"(how many copies of\s+)([^.?!?\n]+)(\?)",
    re.I,
)
_PAYMENT_LEADIN_RE = re.compile(
    r"([.!?])\s+("
    r"You will receive|I will email you|Please tell me your email|"
    r"When you open that link|I need a confirmed email|I sent the secure payment link"
    r")",
    re.I,
)
_EMAIL_SPELL_LEADIN_RE = re.compile(
    r"([.!?])\s+(Slowly,?\s+letter by letter|Now I will read it back slowly)",
    re.I,
)
_PAYMENT_PHRASE_RE = re.compile(
    r"\b(secure Shopify payment link|payment link|order summary|email address)\b",
    re.I,
)
_EMAIL_SPELL_PHRASE_RE = re.compile(r"\b(letter by letter)\b", re.I)
_ERROR_SIGNAL_RE = re.compile(
    r"\b(failed|failure|error|unable|cannot|couldn't|denied|rejected|problem|sorry)\b",
    re.I,
)
_SUCCESS_SIGNAL_RE = re.compile(
    r"\b(paid|shipped|confirmed|delivered|approved|verified|complete|completed|success|found your order)\b",
    re.I,
)
_CALM_USER_RE = re.compile(
    r"^\s*(?:yes|yeah|yep|ok(?:ay)?|sure|thanks|thank you|no problem|sounds good)\s*[.!]?\s*$",
    re.I,
)
# Speech flow curve — peak zones (numbers, order IDs, confirmations)
_FLOW_PEAK_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\*\*[^*]+\*\*"),
    re.compile(r"(?<!\*)\*[^*]+\*(?!\*)"),
    re.compile(r"\([^)]+\)"),
    re.compile(r"\border\s+#?\d{4,}\b", re.I),
    re.compile(r"#\d{4,}\b"),
    re.compile(r"\b\d{1,6}\s+dollars(?:\s+and\s+\d{1,2}\s+cents)?\b", re.I),
    re.compile(r"\b\d{4,}\b"),
    re.compile(
        r"\b(paid|shipped|confirmed|delivered|approved|verified|complete|completed|ready)\b",
        re.I,
    ),
    re.compile(r"\b(?:one|\d+)\s+(?:copies?|copy)\b", re.I),
    re.compile(r"\bhow many copies\b", re.I),
    re.compile(
        r"\b(?:payment link|secure Shopify|order summary|email address|letter by letter)\b",
        re.I,
    ),
    re.compile(r"Found it\s*[—\-]\s*[^.?!]+", re.I),
)
_CLOSE_FLOW_SKIP_RE = re.compile(
    r"\b(goodbye|good bye|thank you for calling|have a great day|take care|talk to you later)\b",
    re.I,
)


@dataclass(frozen=True)
class EmotionPacingProfile:
    """Continuous speech pacing derived from emotion_field."""

    pause_scale: float = 1.0
    max_idea_words: int = 12
    inter_idea_pause_scale: float = 1.0
    emphasis_pause_boost: float = 1.0


def default_emotion_field() -> dict[str, float]:
    return {"valence": 0.0, "arousal": 0.3, "stability": 0.7}


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def ensure_emotion_field(session: "SessionState | None") -> dict[str, float]:
    if session is None:
        return default_emotion_field()
    field = getattr(session, "emotion_field", None)
    if not isinstance(field, dict) or not field:
        session.emotion_field = default_emotion_field()
        return session.emotion_field
    for key, default in default_emotion_field().items():
        field.setdefault(key, default)
    return field


def note_emotion_interrupt(session: "SessionState | None") -> None:
    """Record caller interrupt — decreases stability (volatile field)."""
    if session is None:
        return
    from ..state.emotion_memory import note_interrupt_memory

    ef = ensure_emotion_field(session)
    ef["stability"] = _clamp(ef["stability"] - 0.15, 0.0, 1.0)
    note_interrupt_memory(session)


def evolve_emotion_field(
    session: "SessionState | None",
    *,
    response_text: str = "",
    user_text: str = "",
) -> dict[str, float]:
    """
    Evolve the continuous emotional field from turn signals.

    Uses exponential smoothing so changes feel gradual, not rule-flips.
    """
    ef = ensure_emotion_field(session)
    if session is None:
        return ef

    combined = f"{response_text} {user_text}".lower()
    target_valence = ef["valence"]
    target_arousal = ef["arousal"]
    target_stability = ef["stability"]

    if _ERROR_SIGNAL_RE.search(combined):
        target_valence -= 0.25
        target_arousal += 0.18

    if _SUCCESS_SIGNAL_RE.search(combined):
        target_valence += 0.20
        target_arousal -= 0.10

    if user_text and _CALM_USER_RE.match(user_text.strip()):
        target_stability += 0.12

    alpha = 0.35
    ef["valence"] = _clamp(ef["valence"] + alpha * (target_valence - ef["valence"]), -1.0, 1.0)
    ef["arousal"] = _clamp(ef["arousal"] + alpha * (target_arousal - ef["arousal"]), 0.0, 1.0)
    ef["stability"] = _clamp(
        ef["stability"] + alpha * (target_stability - ef["stability"]),
        0.0,
        1.0,
    )

    from ..state.emotion_memory import effective_emotion_field, ensure_emotional_memory, record_emotion_turn

    record_emotion_turn(
        session,
        had_success=bool(_SUCCESS_SIGNAL_RE.search(combined)),
        had_failure=bool(_ERROR_SIGNAL_RE.search(combined)),
    )
    memory = ensure_emotional_memory(session)
    return effective_emotion_field(ef, memory)


def emotion_pacing_profile(emotion_field: dict[str, float] | None) -> EmotionPacingProfile:
    """
    Map continuous emotion_field → speech pacing coefficients.

    pause_scale = base * (1 + arousal - stability)
    """
    ef = emotion_field or default_emotion_field()
    valence = float(ef.get("valence", 0.0))
    arousal = float(ef.get("arousal", 0.3))
    stability = float(ef.get("stability", 0.7))

    pause_scale = max(0.45, 1.0 + arousal - stability)
    inter_idea_pause_scale = pause_scale * (1.0 - max(0.0, valence) * 0.22)
    emphasis_pause_boost = 1.0 + max(0.0, -valence) * 0.35
    max_idea_words = int(round(_MAX_IDEA_WORDS * (1.0 - 0.38 * arousal)))
    max_idea_words = max(6, min(_MAX_IDEA_WORDS, max_idea_words))

    return EmotionPacingProfile(
        pause_scale=pause_scale,
        max_idea_words=max_idea_words,
        inter_idea_pause_scale=inter_idea_pause_scale,
        emphasis_pause_boost=emphasis_pause_boost,
    )


def _scaled_pause(base_dots: int, scale: float) -> str:
    count = max(1, round(base_dots * scale))
    return "." * count


def _flow_pause(base_dots: int, scale: float) -> str:
    """Flow-curve pauses stay at least two dots so they read as rhythm, not periods."""
    count = max(2, round(base_dots * scale))
    return "." * count


def _flow_peak_positions(body: str, entry_pos: int, exit_bound: int) -> set[int]:
    """Detect peak zones once per emphasis span or unmatched pattern."""
    peaks: set[int] = set()
    for match in _ANY_EMPHASIS_MARKER_RE.finditer(body):
        start = match.start()
        if entry_pos < start < exit_bound:
            peaks.add(start)
    for pattern in _FLOW_PEAK_PATTERNS:
        for match in pattern.finditer(body):
            start = match.start()
            if _inside_emphasis_marker(body, start):
                continue
            if any(start >= p and start < p + 8 for p in peaks):
                continue
            if entry_pos < start < exit_bound:
                peaks.add(start)
    return peaks


def _insert_flow_pause(text: str, index: int, pause: str) -> str:
    """Insert a flow pause at index, skipping duplicate dot runs."""
    if index <= 0 or index > len(text) or not pause:
        return text
    before = text[max(0, index - len(pause)):index]
    if before.endswith(".") or pause in before:
        return text
    return text[:index] + pause + text[index:]


def _apply_speech_flow_curve(sentence: str, profile: EmotionPacingProfile) -> str:
    """
    Shape one sentence with entry / mid / peak / exit rhythm.

    ENTRY — slower calm start | MID — normal | PEAK — lead-in pause |
    EXIT — compact wrap-up (no extra pauses in closing words).
    """
    body = (sentence or "").strip()
    if not body:
        return sentence

    trailing = ""
    if body[-1] in ".!?":
        trailing = body[-1]
        body = body[:-1].strip()

    if _CLOSE_FLOW_SKIP_RE.search(body):
        return sentence

    words = body.split()
    if len(words) < 4:
        return sentence

    entry_n = max(2, min(4, len(words) // 3))
    exit_n = max(2, len(words) // 5)
    exit_start = max(entry_n + 1, len(words) - exit_n)

    entry_pause = _flow_pause(2, profile.pause_scale * 1.25)
    peak_lead = _flow_pause(2, profile.pause_scale * 1.12)

    entry_pos = len(" ".join(words[:entry_n]))
    exit_bound = len(" ".join(words[:exit_start]))

    peak_positions = _flow_peak_positions(body, entry_pos, exit_bound)

    insertions: list[tuple[int, str]] = [(entry_pos, entry_pause)]
    for pos in sorted(peak_positions):
        insertions.append((pos, peak_lead))

    result = body
    for pos, pause in sorted(insertions, key=lambda item: item[0], reverse=True):
        result = _insert_flow_pause(result, pos, pause)

    return f"{result}{trailing}"


def _apply_speech_flow_to_text(text: str, profile: EmotionPacingProfile) -> str:
    """Apply flow curve to a single idea/chunk (streaming-safe)."""
    return _apply_speech_flow_curve(text, profile)


def _pace_ideas_with_flow(
    ideas: list[str],
    profile: EmotionPacingProfile,
) -> list[str]:
    """Render prosody per idea after speech-flow shaping."""
    paced: list[str] = []
    for idea in ideas:
        curved = _apply_speech_flow_curve(idea, profile)
        paced.append(_render_emphasis_pacing(curved, profile))
    return paced


@dataclass(frozen=True)
class VoiceFormattedResponse:
    speech_text: str
    should_pause: bool
    next_action: NextAction


def _strip_internal_content(text: str) -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        return ""
    cleaned = _REASONING_BLOCK_RE.sub(" ", cleaned)
    cleaned = _JSON_BLOCK_RE.sub(" ", cleaned)
    cleaned = _JSON_OBJECT_RE.sub(" ", cleaned)
    cleaned = _MARKDOWN_HEADING_RE.sub(" ", cleaned)
    for pattern in _INTERNAL_PHRASES:
        cleaned = pattern.sub(" ", cleaned)
    cleaned = _ROBOTIC_TOOL_RE.sub(" ", cleaned)

    lines = cleaned.splitlines()
    kept: list[str] = []
    bullet_hits = sum(1 for line in lines if _BULLET_LINE_RE.match(line))
    kv_hits = sum(1 for line in lines if _KV_DUMP_RE.match(line))
    drop_bullets = bullet_hits >= 3
    drop_kv = kv_hits >= 2
    for line in lines:
        if drop_bullets and _BULLET_LINE_RE.match(line):
            continue
        if drop_kv and _KV_DUMP_RE.match(line):
            continue
        kept.append(line)
    cleaned = " ".join(kept)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned


def _split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p.strip() for p in parts if p.strip()]


def _extract_primary_and_question(sentences: list[str]) -> tuple[str, str]:
    if not sentences:
        return "", ""
    questions = [s for s in sentences if s.rstrip().endswith("?")]
    non_questions = [s for s in sentences if not s.rstrip().endswith("?")]
    primary = " ".join(non_questions[:3]).strip()
    follow_up = questions[-1].strip() if questions else ""
    if not primary and sentences:
        primary = sentences[0]
        if primary.rstrip().endswith("?"):
            follow_up = primary
            primary = ""
    return primary, follow_up


def _combine_primary_and_question(primary: str, follow_up: str) -> str:
    primary = primary.strip()
    follow_up = follow_up.strip()
    if primary and follow_up:
        if follow_up.lower() in primary.lower():
            return primary
        return f"{primary.rstrip('.!?')}. {follow_up}".strip()
    return primary or follow_up


def _compress_to_budget(text: str, max_chars: int = MAX_SPEECH_CHARS) -> str:
    text = text.strip()
    if len(text) <= max_chars:
        return text

    sentences = _split_sentences(text)
    if not sentences:
        return text[:max_chars].rstrip()

    kept: list[str] = []
    for sentence in sentences[:3]:
        candidate = " ".join(kept + [sentence]).strip()
        if len(candidate) > max_chars:
            break
        kept.append(sentence)

    if kept:
        result = " ".join(kept).strip()
        if len(result) <= max_chars:
            return result

    words = text.split()
    out: list[str] = []
    for word in words:
        candidate = " ".join(out + [word])
        if len(candidate) > max_chars - 1:
            break
        out.append(word)
    result = " ".join(out).rstrip(",;:")
    if not result:
        result = text[: max_chars - 1].rstrip()
    if result and not result.endswith((".", "!", "?")):
        result += "."
    return result[:max_chars].strip()


def _pronounce_usd_amount(amount: float) -> str:
    """Speak dollar amounts for TTS, e.g. 90.99 → ``90 dollars and 99 cents``."""
    if amount < 0:
        amount = abs(amount)
    dollars = int(amount)
    cents = int(round((amount - dollars) * 100))
    if cents >= 100:
        dollars += 1
        cents = 0
    dollar_word = "dollar" if dollars == 1 else "dollars"
    if cents == 0:
        return f"{dollars} {dollar_word}"
    cent_word = "cent" if cents == 1 else "cents"
    if dollars == 0:
        return f"{cents} {cent_word}"
    return f"{dollars} {dollar_word} and {cents} {cent_word}"


def _normalize_money_in_text(text: str) -> str:
    def _replace(match: re.Match) -> str:
        raw = match.group(1).replace(",", "")
        try:
            amount = float(raw)
        except ValueError:
            return match.group(0)
        return _pronounce_usd_amount(amount)

    return _MONEY_IN_TEXT_RE.sub(_replace, text or "")


def _inside_emphasis_marker(text: str, index: int) -> bool:
    for match in _ANY_EMPHASIS_MARKER_RE.finditer(text):
        if match.start() <= index < match.end():
            return True
    return False


def _emphasize_pattern_level(
    text: str,
    pattern: re.Pattern[str],
    wrap: Callable[[str], str],
) -> str:
    parts: list[str] = []
    last = 0
    for match in pattern.finditer(text):
        if _inside_emphasis_marker(text, match.start()):
            continue
        parts.append(text[last:match.start()])
        parts.append(wrap(match.group(0)))
        last = match.end()
    if not parts:
        return text
    parts.append(text[last:])
    return "".join(parts)


def _wrap_medium_span(span: str) -> str:
    inner = (span or "").strip()
    if not inner or _ANY_EMPHASIS_MARKER_RE.search(inner):
        return span
    return f"*{inner}*"


def _insert_semantic_idea_breaks(text: str) -> str:
    """Force inter-chunk pauses before payment/email instruction blocks."""
    result = text or ""
    result = _PAYMENT_LEADIN_RE.sub(r"\1\n\2", result)
    result = _EMAIL_SPELL_LEADIN_RE.sub(r"\1\n\2", result)
    result = re.sub(
        r"([.!?])\s+(How many copies)",
        r"\1\n\2",
        result,
        flags=re.I,
    )
    result = re.sub(
        r"([.!?])\s+(Do you want another)",
        r"\1\n\2",
        result,
        flags=re.I,
    )
    result = re.sub(
        r"([.!?])\s+(Just to confirm)",
        r"\1\n\2",
        result,
        flags=re.I,
    )
    return result


def _apply_semantic_chunk_prosody(text: str) -> str:
    """
    Unified pacing for order, product, payment, and email flows.

    Inserts prosody markers (*, **) so SpeechPacer adds micro-pauses after
    product names, quantities, and before payment/email instructions.
    """
    if not text:
        return ""

    result = _insert_semantic_idea_breaks(text)

    result = _SEMANTIC_QUANTITY_RE.sub(lambda m: _wrap_medium_span(m.group(1)), result)
    result = _HOW_MANY_COPIES_RE.sub(lambda m: _wrap_medium_span(m.group(1)), result)

    result = _FOUND_IT_TITLE_RE.sub(
        lambda m: f"{m.group(1)}{_wrap_medium_span(m.group(2))}{m.group(3)}",
        result,
    )
    result = _OF_TITLE_RE.sub(
        lambda m: f"{m.group(1)}{_wrap_medium_span(m.group(2))}{m.group(3)}",
        result,
    )
    result = _COPIES_OF_TITLE_RE.sub(
        lambda m: f"{m.group(1)}{_wrap_medium_span(m.group(2))}{m.group(3)}",
        result,
    )

    result = _PAYMENT_PHRASE_RE.sub(lambda m: _wrap_medium_span(m.group(1)), result)
    result = _EMAIL_SPELL_PHRASE_RE.sub(lambda m: _wrap_medium_span(m.group(1)), result)

    return result


def _apply_prosody_emphasis(text: str) -> str:
    """
    Apply multi-level prosody markers for SpeechPacer (stripped before TTS).

    mild (word) — confirmations / neutral status
    *medium* — money and order IDs
    **strong** — errors, failures, critical actions
    """
    if not text:
        return ""
    result = text
    for pattern in _EMPHASIS_STRONG:
        result = _emphasize_pattern_level(result, pattern, lambda s: f"**{s}**")
    for pattern in _EMPHASIS_MEDIUM:
        result = _emphasize_pattern_level(result, pattern, lambda s: f"*{s}*")
    for pattern in _EMPHASIS_MILD:
        result = _emphasize_pattern_level(result, pattern, lambda s: f"({s})")
    return result


def _render_emphasis_pacing(
    text: str,
    profile: EmotionPacingProfile | None = None,
) -> str:
    """Convert internal emphasis markers into emotion-scaled micro-pauses."""
    pacing = profile or EmotionPacingProfile()
    scale = pacing.pause_scale * pacing.emphasis_pause_boost
    mild = _scaled_pause(2, scale)
    medium = _scaled_pause(3, scale)
    strong = _scaled_pause(6, scale)

    trailing = ""
    base = text or ""
    if base.endswith((".", "!", "?")):
        trailing = base[-1]
        base = base[:-1]

    rendered = _STRONG_EMPHASIS_RE.sub(rf"{strong}\1{strong}", base)
    rendered = _MEDIUM_EMPHASIS_RE.sub(rf"{medium}\1{medium}", rendered)
    rendered = _MILD_EMPHASIS_RE.sub(rf"{mild}\1{mild}", rendered)

    if trailing and trailing != ".":
        rendered = f"{rendered}{trailing}"
    elif trailing == "." and not re.search(
        rf"(?:{re.escape(strong)}|{re.escape(medium)}|{re.escape(mild)})[^.\n]*(?:{re.escape(strong)}|{re.escape(medium)}|{re.escape(mild)})$",
        rendered,
    ):
        rendered = f"{rendered}."
    return rendered


def _ideas_from_text(text: str, *, max_idea_words: int = _MAX_IDEA_WORDS) -> list[str]:
    """Split speech into short, single-idea units."""
    cleaned = (text or "").strip()
    if not cleaned:
        return []

    ideas: list[str] = []
    for paragraph in re.split(r"\n+", cleaned):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        sentences = _split_sentences(paragraph)
        if not sentences:
            sentences = [paragraph]
        for sentence in sentences:
            core = sentence.strip()
            if not core:
                continue
            trailing = ""
            if core.endswith("?"):
                trailing = "?"
                body = core[:-1].strip()
            elif core.endswith("!"):
                trailing = "!"
                body = core[:-1].strip()
            elif core.endswith("...") and not core.endswith("...."):
                body = core.strip()
            elif re.search(r"\.{2,}[^.\n]+\.{2,}", core):
                body = core.strip()
            elif core.endswith("."):
                trailing = "."
                body = core[:-1].strip()
            else:
                body = core.strip()
            if not body:
                continue
            words = body.split()
            if len(words) <= max_idea_words:
                ideas.append(f"{body}{trailing}")
                continue
            parts = re.split(r",\s+|\s+and\s+", body, flags=re.I)
            for index, part in enumerate(parts):
                part = part.strip()
                if not part:
                    continue
                suffix = trailing if index == len(parts) - 1 else "."
                ideas.append(f"{part}{suffix}")
    return ideas


class SpeechPacer:
    """Natural pauses, prosody emphasis, and continuous emotion-scaled pacing."""

    def pace(
        self,
        text: str,
        *,
        max_chars: int = MAX_SPEECH_CHARS,
        emotion_field: dict[str, float] | None = None,
    ) -> str:
        profile = emotion_pacing_profile(emotion_field)
        normalized = _normalize_money_in_text(text)
        semantic = _apply_semantic_chunk_prosody(normalized)
        emphasized = _apply_prosody_emphasis(semantic)
        raw_ideas = _ideas_from_text(emphasized, max_idea_words=profile.max_idea_words)
        if not raw_ideas:
            flowed = _apply_speech_flow_to_text(emphasized, profile)
            return _render_emphasis_pacing(flowed, profile).strip()

        prosody_ideas = _pace_ideas_with_flow(raw_ideas, profile)
        if len(prosody_ideas) == 1:
            return prosody_ideas[0]

        inter_pause = _scaled_pause(3, profile.inter_idea_pause_scale)
        lines: list[str] = []
        for index, idea in enumerate(prosody_ideas):
            body = idea.rstrip()
            if not body:
                continue
            is_last = index == len(prosody_ideas) - 1
            if is_last:
                if body.endswith("?"):
                    lines.append(body)
                elif body.endswith("!"):
                    lines.append(body)
                elif re.search(r"\.{2,}[^.\n]+\.{2,}", body):
                    lines.append(body)
                elif re.search(r"\.{2,}$", body):
                    lines.append(body)
                elif body.endswith("."):
                    lines.append(body)
                else:
                    lines.append(f"{body}.")
            else:
                unit = body.rstrip(".!?").strip()
                if re.search(r"\.{2,}$", unit):
                    lines.append(unit)
                else:
                    lines.append(f"{unit}{inter_pause}")

        paced = "\n".join(lines)
        if len(paced) <= max_chars:
            return paced

        kept: list[str] = []
        for line in lines:
            candidate = "\n".join(kept + [line]).strip()
            if len(candidate) > max_chars:
                break
            kept.append(line)
        if kept:
            return "\n".join(kept)
        return lines[0][:max_chars].strip()


def _infer_next_action(speech_text: str) -> NextAction:
    lower = speech_text.lower().strip()
    if not lower:
        return "answer"
    close_markers = (
        "goodbye",
        "good bye",
        "thank you for calling",
        "have a great day",
        "take care",
        "talk to you later",
    )
    if any(marker in lower for marker in close_markers):
        return "close"
    if speech_text.rstrip().endswith("?"):
        confirm_markers = (
            "is that correct",
            "did i get that right",
            "is this correct",
            "can you confirm",
            "would you like me to",
            "should i ",
        )
        if any(marker in lower for marker in confirm_markers):
            return "confirm"
        return "ask"
    if any(
        marker in lower
        for marker in ("please confirm", "just to confirm", "let me confirm")
    ):
        return "confirm"
    return "answer"


class VoiceResponseFormatter:
    """Normalize handler/LLM strings into semantic speech (no pacing — that is finalize-only)."""

    def format(
        self,
        raw_text: str,
        session: "SessionState | None" = None,
        *,
        user_text: str = "",
    ) -> VoiceFormattedResponse:
        cleaned = _strip_internal_content(raw_text)
        if not cleaned:
            cleaned = (raw_text or "").strip()

        evolve_emotion_field(
            session,
            response_text=cleaned,
            user_text=user_text,
        )

        sentences = _split_sentences(cleaned)
        primary, follow_up = _extract_primary_and_question(sentences)
        speech = _combine_primary_and_question(primary, follow_up)
        if not speech:
            speech = cleaned

        if len(speech) > MAX_SPEECH_CHARS:
            speech = _compress_to_budget(speech, MAX_SPEECH_CHARS)

        next_action = _infer_next_action(speech)
        should_pause = next_action in ("ask", "confirm")

        if len(raw_text or "") > MAX_SPEECH_CHARS and len(speech) <= MAX_SPEECH_CHARS:
            logger.info(
                "voice_formatter_compressed chars=%d->%d action=%s",
                len(raw_text or ""),
                len(speech),
                next_action,
            )

        return VoiceFormattedResponse(
            speech_text=speech,
            should_pause=should_pause,
            next_action=next_action,
        )


_default_formatter = VoiceResponseFormatter()


def format_voice_response(
    raw_text: str,
    session: "SessionState | None" = None,
    *,
    user_text: str = "",
) -> VoiceFormattedResponse:
    """Format raw text for Twilio TTS (module-level convenience)."""
    return _default_formatter.format(raw_text, session, user_text=user_text)
