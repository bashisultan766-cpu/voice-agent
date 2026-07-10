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

export function isPartialEmailCorrection(text: string): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  return (
    /\breplace\s+\w\s+with\s+\w/i.test(t) ||
    /\bdouble\s+[a-z]\b/i.test(t) ||
    /\b(use|switch\s+to|instead\s+of)\b.*\b(yahoo|gmail|outlook|hotmail|icloud)\b/i.test(t) ||
    /\bnot\s+sultan\b/i.test(t) ||
    /\bsultaan\b/i.test(t) ||
    /\bcompany\s+email\b/i.test(t) ||
    /\bletter\s+by\s+letter\b/i.test(t) ||
    /\brepeat\s+(?:it\s+)?slowly\b/i.test(t)
  );
}

export function isRequestSlowEmailRepeat(text: string): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  return (
    /\bletter\s+by\s+letter\b/i.test(t) ||
    /\brepeat\s+(?:it\s+)?slowly\b/i.test(t) ||
    /\bsay\s+it\s+again\s+slowly\b/i.test(t)
  );
}

/** Apply spoken partial corrections to the current email — latest correction wins. */
export function applyPartialEmailCorrection(
  currentEmail: string,
  text: string,
): string | null {
  const base = (currentEmail ?? "").trim().toLowerCase();
  if (!base.includes("@")) return null;

  const fullReplacement = extractEmailFromSpeech(text);
  if (fullReplacement) return fullReplacement;

  let [localPart, domainPart] = base.split("@", 2);
  const t = (text ?? "").trim().toLowerCase();

  const replaceMatch = t.match(/\breplace\s+([a-z0-9])\s+with\s+([a-z0-9])/i);
  if (replaceMatch) {
    const from = replaceMatch[1].toLowerCase();
    const to = replaceMatch[2].toLowerCase();
    localPart = localPart.split(from).join(to);
  }

  const doubleMatch = t.match(/\bdouble\s+([a-z])'?s?\b/i);
  if (doubleMatch) {
    const ch = doubleMatch[1].toLowerCase();
    const occurrences = (localPart.match(new RegExp(ch, "gi")) ?? []).length;
    if (occurrences === 1) {
      localPart = `${localPart}${ch}`;
    } else {
      localPart = localPart.replace(new RegExp(`${ch}(?!${ch})`, "i"), `${ch}${ch}`);
    }
  }

  if (/\bsultaan\b/i.test(t)) {
    localPart = localPart.replace(/sultan/gi, "sultaan");
  }

  if (/\b(use\s+)?yahoo\b/i.test(t) && /\b(instead\s+of|not)\b.*\bgmail\b/i.test(t)) {
    domainPart = domainPart.replace(/gmail\.com/i, "yahoo.com").replace(/^gmail$/i, "yahoo.com");
  } else if (/\b(use\s+)?gmail\b/i.test(t) && /\b(instead\s+of|not)\b.*\byahoo\b/i.test(t)) {
    domainPart = domainPart.replace(/yahoo\.com/i, "gmail.com").replace(/^yahoo$/i, "gmail.com");
  } else if (/\b(use\s+)?yahoo\b/i.test(t) && !/\bgmail\b/i.test(t)) {
    domainPart = domainPart.replace(/gmail\.com/i, "yahoo.com").replace(/^gmail$/i, "yahoo.com");
  } else if (/\b(use\s+)?gmail\b/i.test(t) && !/\byahoo\b/i.test(t)) {
    domainPart = domainPart.replace(/yahoo\.com/i, "gmail.com").replace(/^yahoo$/i, "gmail.com");
  }
  if (/\boutlook\b/i.test(t)) domainPart = "outlook.com";
  if (/\bhotmail\b/i.test(t)) domainPart = "hotmail.com";

  const hyphenLocal = t.match(/\b([a-z0-9](?:-[a-z0-9])+)\b/i);
  if (hyphenLocal?.[1] && t.includes("@")) {
    const rebuilt = hyphenLocal[1].replace(/-/g, "");
    if (rebuilt) localPart = rebuilt;
  }

  const candidate = `${localPart}@${domainPart}`.replace(/\s+/g, "");
  if (candidate === base.replace(/\s+/g, "")) return null;
  if (!isValidCustomerEmail(candidate)) return null;
  return candidate.toLowerCase();
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

export function buildUpdatedEmailConfirmationSpeech(email: string): string {
  const spelled = spellEmailHyphenForTTS(email);
  return `Thank you. I have updated it. Your email is ${spelled}. Is that correct?`;
}

const EMAIL_WORKFLOW_ABORT_RE =
  /\b(?:never\s*mind|forget\s+(?:it|that|about\s+(?:that|this|support))|cancel(?:\s+(?:that|this|support))?|stop\s+(?:that|this)|don'?t\s+(?:send|bother|want\s+(?:support|that)))\b/i;

const EMAIL_WORKFLOW_PIVOT_ORDER_RE =
  /\b(?:give\s+me\s+(?:the\s+)?tracking|just\s+(?:give|tell)\s+me(?:\s+(?:my\s+)?(?:tracking|the\s+tracking))?(?:\s+id)?|where\s+is\s+my\s+(?:tracking|order)|check\s+my\s+order|what\s+about\s+my\s+order|look\s+up\s+my\s+order|order\s+status|(?:want|need)\s+(?:my\s+)?tracking)\b/i;

/** Caller wants to exit email capture and return to order / tracking help. */
export function shouldAbortEmailConfirmation(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return EMAIL_WORKFLOW_ABORT_RE.test(t) || EMAIL_WORKFLOW_PIVOT_ORDER_RE.test(t);
}

const ORDER_CONTEXT_SWITCH_RE =
  /\b(?:give\s+me|want|need|check|tell\s+me|what\s+(?:is|was)|where\s+is|how\s+much|how\s+many)\b[\s\S]{0,40}\b(tracking|order|refund|payment|notification|timeline|total|fee|card|confirmation\s+email|processing\s+fee)\b/i;

/** Caller pivots from a locked workflow back to current-order questions (LLM should answer). */
export function isOrderContextSwitchUtterance(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (shouldAbortEmailConfirmation(t)) return true;
  if (/\bmy\s+tracking\s+number\s+is\b/i.test(t)) return false;
  if (looksLikePartialEmail(t) || extractEmailFromSpeech(t)) return false;
  if (isEmailConfirmation(t) || isEmailRejection(t)) return false;
  return ORDER_CONTEXT_SWITCH_RE.test(t);
}
