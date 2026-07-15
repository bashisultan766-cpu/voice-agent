/**
 * Static local brand profile for Mail Call Communication.
 * Used for identity questions and when live CMS retrieval is offline.
 * Copy is written for spoken delivery (short, natural, no technical jargon).
 */

export const BRAND_NAME = "Mail Call Communication";
export const BRAND_WEBSITE = "https://mailcallcommunication.com";
export const BRAND_LOCATION = "Abbottabad, Pakistan";

export const BRAND_PROFILE = {
  name: BRAND_NAME,
  website: BRAND_WEBSITE,
  location: BRAND_LOCATION,
  whatWeAre:
    "Mail Call Communication is an elite news publication covering cutting-edge current events, local developments, and public-interest journalism.",
  mission:
    "Our mission is to provide accurate, objective, and timely journalism and public information to our community.",
  locationSpoken:
    "We are based in Abbottabad, Pakistan, where our newsroom serves readers across the region and beyond.",
  contactSpoken:
    "You can reach us through mailcallcommunication.com for newsroom inquiries and publication details.",
  officeSpoken:
    "Our editorial office operates from Abbottabad, Pakistan, and we're glad to help with questions about our newspaper and coverage.",
} as const;

/** Short spoken answers keyed for identity / general brand intents. */
export const BRAND_SPOKEN_ANSWERS = {
  identity:
    "I'd be glad to tell you about that. Mail Call Communication is an elite news publication covering current events, local developments, and public-interest journalism.",
  mission:
    "I'd be glad to tell you about that. Mail Call Communication is dedicated to accurate, objective, and timely journalism for our community.",
  location:
    "I'd be glad to tell you about that. Our newsroom is based in Abbottabad, Pakistan.",
  contact:
    "I'd be glad to tell you about that. You can find us at mailcallcommunication.com for newsroom and publication inquiries.",
  general:
    "I'd be glad to tell you about that. Mail Call Communication is dedicated to accurate journalism from our newsroom in Abbottabad, Pakistan. How else can I help with the newspaper today?",
  offTopic:
    "I'm here to help you with anything related to Mail Call Communication and our publications. How can I assist you with the newspaper today?",
} as const;

const IDENTITY_RE =
  /\b(who are you|what (is|are) (mail ?call|this|your)|tell me about (mail ?call|yourself|the (paper|newspaper|publication))|about (the )?(paper|newspaper|publication|mail ?call)|what do you (do|cover)|introduce)\b/i;
const MISSION_RE =
  /\b(mission|purpose|why (do )?you|what('s| is) your (goal|aim)|dedicated to|journalism)\b/i;
const LOCATION_RE =
  /\b(where (are|is) you|location|based|office|address|abbottabad|pakistan|city)\b/i;
const CONTACT_RE =
  /\b(contact|phone|email|reach you|website|web ?site|how (can|do) i (reach|contact))\b/i;

/**
 * Match a caller utterance to static brand copy (identity / about questions).
 * Returns null when the query should go to live article retrieval instead.
 */
export function matchBrandProfileQuery(utterance: string): string | null {
  const q = utterance.trim();
  if (!q) return null;

  if (LOCATION_RE.test(q)) return BRAND_SPOKEN_ANSWERS.location;
  if (CONTACT_RE.test(q)) return BRAND_SPOKEN_ANSWERS.contact;
  if (MISSION_RE.test(q)) return BRAND_SPOKEN_ANSWERS.mission;
  if (IDENTITY_RE.test(q)) return BRAND_SPOKEN_ANSWERS.identity;

  // Bare "about mail call" style prompts
  if (/^about\b/i.test(q) && /mail\s*call/i.test(q)) {
    return BRAND_SPOKEN_ANSWERS.identity;
  }

  return null;
}

/** Natural spoken fallback when live CMS is offline — never mentions technical failures. */
export function brandOfflineFallbackSpeech(utterance: string): string {
  return matchBrandProfileQuery(utterance) ?? BRAND_SPOKEN_ANSWERS.general;
}

/** Compact context block for the LLM when serving from the local brand profile. */
export function buildBrandProfileKnowledgeBlock(): string {
  return [
    "BRAND PROFILE (authoritative local copy — speak naturally from this):",
    `Name: ${BRAND_PROFILE.name}`,
    `About: ${BRAND_PROFILE.whatWeAre}`,
    `Mission: ${BRAND_PROFILE.mission}`,
    `Location: ${BRAND_PROFILE.locationSpoken}`,
    `Contact: ${BRAND_PROFILE.contactSpoken}`,
    "Do not invent other facts. Keep replies to 2–3 short spoken sentences.",
  ].join("\n");
}

/** Off-topic redirect — newspaper domain only. */
export function offTopicRedirectSpeech(): string {
  return BRAND_SPOKEN_ANSWERS.offTopic;
}
