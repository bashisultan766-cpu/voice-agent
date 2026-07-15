/**
 * Cleanse WordPress payloads for TTS: strip HTML, shortcodes, markdown, URLs.
 * Voice turns must never speak raw markup or long links.
 * Also normalizes common Twilio STT mis-hears of MailCall brand vocabulary.
 */

const HTML_TAG_RE = /<\/?[^>]+>/g;
const SHORTCODE_RE = /\[[^\]]+\]/g;
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const MD_EMPHASIS_RE = /(\*{1,3}|_{1,3}|`{1,3})(.*?)\1/g;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const ENTITY_RE = /&(#x?[0-9a-f]+|[a-z]+);/gi;
const MULTI_SPACE_RE = /\s+/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (_, raw: string) => {
    const key = raw.toLowerCase();
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[key] ?? "";
  });
}

/**
 * Phonetic / STT repair map — apply BEFORE keyword extraction or brand matching.
 * Twilio often hears "MailCall Newspaper" as medical/male variants.
 */
const VOICE_TRANSCRIPT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bmedical\s+newspaper\b/gi, "MailCall Newspaper"],
  [/\bmedical\s+commutation\b/gi, "MailCall Newspaper"],
  [/\bmedical\s+communication\b/gi, "MailCall Newspaper"],
  [/\bmale\s+communication\b/gi, "MailCall Newspaper"],
  [/\bmale\s+confirming\b/gi, "MailCall Newspaper"],
  [/\bmale\s+call\s+newspaper\b/gi, "MailCall Newspaper"],
  [/\bmail\s+communication\b/gi, "MailCall Newspaper"],
  [/\bmail\s+call\s+communication\b/gi, "Mail Call Communication"],
  [/\bmale\s+call\b/gi, "Mail Call"],
  [/\bmedical\s+call\b/gi, "Mail Call"],
  [/\bmay\s+call\s+newspaper\b/gi, "MailCall Newspaper"],
  [/\bnail\s+call\b/gi, "Mail Call"],
];

/**
 * Normalize a raw voice transcript for brand/keyword matching.
 * Does not alter TTS output paths — only inbound understanding.
 */
export function normalizeVoiceTranscript(input: string | null | undefined): string {
  let text = String(input ?? "").trim();
  if (!text) return "";
  for (const [pattern, replacement] of VOICE_TRANSCRIPT_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Convert WP rendered HTML / content into plain speech-safe text.
 */
export function cleanseForSpeech(input: string | null | undefined): string {
  if (!input) return "";

  let text = String(input);
  text = text.replace(MD_IMAGE_RE, "$1");
  text = text.replace(MD_LINK_RE, "$1");
  text = text.replace(HTML_TAG_RE, " ");
  text = text.replace(SHORTCODE_RE, " ");
  text = text.replace(MD_EMPHASIS_RE, "$2");
  text = text.replace(URL_RE, " ");
  text = decodeEntities(text);
  text = text.replace(MULTI_SPACE_RE, " ").trim();
  return text;
}

/**
 * Keep at most `maxSentences` sentences for spoken turns (default 3).
 */
export function truncateToSentences(text: string, maxSentences = 3): string {
  const cleaned = cleanseForSpeech(text);
  if (!cleaned) return "";

  const parts = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (!parts) return cleaned;

  return parts
    .slice(0, maxSentences)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Soft length cap for TTS budgets (~45 words ≈ 2–3 spoken sentences).
 */
export function clampSpokenLength(text: string, maxWords = 55): string {
  const words = cleanseForSpeech(text).split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ").replace(/[,:;]+$/, "")}.`;
}
