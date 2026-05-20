"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VOICE_TTS_MAX_AUDIO_BYTES = exports.VOICE_REPLY_TTS_MAX_CHARS = void 0;
exports.shortenReplyForVoiceTts = shortenReplyForVoiceTts;
exports.VOICE_REPLY_TTS_MAX_CHARS = 120;
exports.VOICE_TTS_MAX_AUDIO_BYTES = 150 * 1024;
function collapseWhitespace(s) {
    return s.replace(/\s+/g, ' ').trim();
}
function truncateAtWord(s, maxLen) {
    if (s.length <= maxLen)
        return s;
    const slice = s.slice(0, maxLen);
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace > Math.floor(maxLen * 0.55))
        return slice.slice(0, lastSpace).trimEnd();
    return slice.trimEnd();
}
function shortenReplyForVoiceTts(original, maxChars = exports.VOICE_REPLY_TTS_MAX_CHARS) {
    const trimmed = collapseWhitespace(original);
    const originalChars = trimmed.length;
    if (!trimmed) {
        return { text: '', reply_shortened: false, originalChars: 0, finalChars: 0 };
    }
    if (originalChars <= maxChars) {
        return {
            text: trimmed,
            reply_shortened: false,
            originalChars,
            finalChars: originalChars,
        };
    }
    const parts = trimmed.split(/(?<=[.!?])\s+/).filter((p) => p.length > 0);
    let acc = '';
    for (const part of parts) {
        const next = acc ? `${acc} ${part}` : part;
        if (next.length <= maxChars) {
            acc = next;
            continue;
        }
        if (!acc) {
            const t = truncateAtWord(part, maxChars - 3);
            acc = `${t}...`;
        }
        break;
    }
    if (!acc) {
        const t = truncateAtWord(trimmed, maxChars - 3);
        acc = `${t}...`;
    }
    const text = acc.trim();
    return {
        text,
        reply_shortened: true,
        originalChars,
        finalChars: text.length,
    };
}
//# sourceMappingURL=voice-reply-tts-shorten.util.js.map