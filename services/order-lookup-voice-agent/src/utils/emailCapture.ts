/**
 * Spoken-email capture — deterministic STT → typed email normalization.
 * Ported from the legacy Python email capture resolver (subset for voice agent).
 */
import { isValidCustomerEmail } from "./resendEmailService.js";

const DIGIT_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  oh: "0",
  nought: "0",
  ate: "8",
};

const DOMAIN_ALIASES: Record<string, string> = {
  gmail: "gmail.com",
  "g mail": "gmail.com",
  yahoo: "yahoo.com",
  ymail: "yahoo.com",
  outlook: "outlook.com",
  hotmail: "hotmail.com",
  icloud: "icloud.com",
  aol: "aol.com",
  proton: "proton.me",
  protonmail: "protonmail.com",
  live: "live.com",
  msn: "msn.com",
  me: "me.com",
  mail: "mail.com",
  zoho: "zoho.com",
  gmx: "gmx.com",
  yandex: "yandex.com",
  googlemail: "gmail.com",
};

const DOMAIN_FIXES: Record<string, string> = {
  gamil: "gmail",
  gmaill: "gmail",
  gmale: "gmail",
  gmai: "gmail",
  yahooo: "yahoo",
  outlok: "outlook",
  hotmial: "hotmail",
};

const TYPED_EMAIL_RE = /\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/i;

const EMAIL_CONFIRM_PATTERNS =
  /^\s*(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|go\s+ahead|absolutely)\b/i;

export function isEmailConfirmation(text: string): boolean {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return false;
  if (EMAIL_CONFIRM_PATTERNS.test(trimmed)) return true;
  if (/^\s*(that\s*'?s\s+)?(right|correct)(\s+email)?\s*[.!]?\s*$/i.test(trimmed)) return true;
  if (/\b(that\s+is|that's)\s+correct\b/i.test(trimmed)) return true;
  if (/\b(you got it|exactly right|sounds?\s+(right|correct|good))\b/i.test(trimmed)) return true;
  return false;
}

export function isEmailRejection(text: string): boolean {
  const lower = (text ?? "").trim().toLowerCase();
  if (!lower) return false;
  return (
    /\b(no|nope|nah|wrong|incorrect|not correct|that's wrong|try again|start again)\b/i.test(
      lower,
    ) && !isEmailConfirmation(text)
  );
}

export function looksLikePartialEmail(text: string): boolean {
  const t = ` ${(text ?? "").toLowerCase()} `;
  if (!t.trim()) return false;
  const markers = [" at ", " dot ", "@", "gmail", "yahoo", "outlook", "hotmail", " activate "];
  return markers.some((m) => t.includes(m));
}

/** Extract typed email if present in speech. */
function extractTypedEmail(text: string): string | null {
  const match = text.match(TYPED_EMAIL_RE);
  return match?.[1]?.toLowerCase().trim() ?? null;
}

/** Convert spoken email phrases to a normalized address. */
export function normalizeSpokenEmail(text: string): string | null {
  let t = (text ?? "").trim().toLowerCase();
  if (!t) return null;

  t = t.replace(
    /^(?:(?:the\s+)?(?:my\s+)?(?:correct\s+)?email(?:\s+address)?\s+is|send\s+(?:it\s+)?to|it'?s)\s+/i,
    "",
  );

  t = t.replace(/\bat the rate\b/g, "at");
  t = t.replace(/\bat rate\b/g, "at");
  t = t.replace(/\bactivate\b/g, "at");
  t = t.replace(
    /\badd\b(?=\s+(?:gmail|yahoo|outlook|hotmail|icloud|aol|proton|live|msn|me|mail|zoho|gmx|yandex)\b)/g,
    "at",
  );
  t = t.replace(/\bperiod\b/g, "dot");
  t = t.replace(/\bhyphen\b/g, "-");
  t = t.replace(/\bdash\b/g, "-");
  t = t.replace(/\bunderscore\b/g, "_");
  t = t.replace(/\bplus\b/g, "+");
  t = t.replace(/\bdot\b/g, ".");
  t = t.replace(/\bat\b/g, "@");

  const compoundNumbers: Array<[RegExp, string]> = [
    [/\bsixty\s+four\b/g, "64"],
    [/\bseventy\s+six\b/g, "76"],
    [/\beighty\s+seven\b/g, "87"],
    [/\bninety\s+one\b/g, "91"],
    [/\bfifty\s+five\b/g, "55"],
    [/\bforty\s+two\b/g, "42"],
    [/\bthirty\s+three\b/g, "33"],
    [/\btwenty\s+one\b/g, "21"],
  ];
  for (const [pattern, value] of compoundNumbers) {
    t = t.replace(pattern, value);
  }

  for (const [word, digit] of Object.entries(DIGIT_WORDS)) {
    t = t.replace(new RegExp(`\\b${word}\\b`, "g"), digit);
  }

  if (!t.includes("@")) return null;

  const [localRaw, domainRaw] = t.split("@", 2);
  let localPart = localRaw.replace(/[,\s]+/g, "");
  let domainPart = domainRaw.replace(/\s+/g, "");

  localPart = localPart.replace(
    /activate(?=(?:gmail|yahoo|outlook|hotmail|icloud|aol|proton|live|msn|me)\b)/gi,
    "",
  );
  if (localPart.toLowerCase().endsWith("activate") && localPart.length > "activate".length) {
    localPart = localPart.slice(0, -"activate".length);
  }

  for (const [wrong, right] of Object.entries(DOMAIN_FIXES)) {
    if (domainPart === wrong || domainPart.startsWith(`${wrong}.`)) {
      domainPart = domainPart.replace(wrong, right);
      break;
    }
  }

  const domainClean = domainPart.replace(/\.$/, "");
  if (DOMAIN_ALIASES[domainClean] && !domainClean.includes(".")) {
    domainPart = DOMAIN_ALIASES[domainClean];
  }

  let email = `${localPart}@${domainPart.replace(/\.$/, "")}`;
  email = email.replace(/[^a-z0-9._%+\-@]/gi, "").replace(/\.$/, "");

  if (!isValidCustomerEmail(email)) return null;
  return email.toLowerCase();
}

/** Resolve email from spoken or typed caller text. */
export function extractEmailFromSpeech(text: string): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  return extractTypedEmail(trimmed) ?? normalizeSpokenEmail(trimmed);
}

const COMMON_DOMAINS: Record<string, string> = {
  "gmail.com": "gmail dot com",
  "yahoo.com": "yahoo dot com",
  "hotmail.com": "hotmail dot com",
  "outlook.com": "outlook dot com",
  "icloud.com": "icloud dot com",
};

function domainVoicePart(domain: string): string {
  const lower = domain.toLowerCase();
  if (COMMON_DOMAINS[lower]) return COMMON_DOMAINS[lower];
  return lower.split(".").join(" dot ");
}

/** Hyphen letter spelling for confirmation — e.g. B-A-S-H-I at gmail dot com */
export function spellEmailHyphenForTTS(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return normalized;
  const [local, domain] = normalized.split("@", 2);
  const localSpelled = [...local]
    .map((ch) => {
      if (/[a-z]/.test(ch)) return ch.toUpperCase();
      if (/[0-9]/.test(ch)) return ch;
      if (ch === ".") return "dot";
      if (ch === "-") return "dash";
      if (ch === "_") return "underscore";
      return ch;
    })
    .join("-");
  return `${localSpelled} at ${domainVoicePart(domain)}`;
}

export function buildEmailConfirmationSpeech(email: string): string {
  const spelled = spellEmailHyphenForTTS(email);
  return `I have your email as ${spelled}. Is that correct?`;
}
