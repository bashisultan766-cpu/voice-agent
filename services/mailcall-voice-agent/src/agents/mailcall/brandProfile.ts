/**
 * Static local brand profile for MailCall Newspaper / Mail Call Communication.
 * Used for identity questions and when live CMS retrieval is offline.
 */

import { SCRIPTS, SUPPORT_EMAIL_SPOKEN } from "./businessRules.js";
import { normalizeVoiceTranscript } from "./textCleaner.js";

export const BRAND_NAME = "Mail Call Communication";
export const BRAND_WEBSITE = "https://mailcallnewspaper.com";
export const BRAND_LOCATION = "Serving families across the United States";

export const BRAND_PROFILE = {
  name: BRAND_NAME,
  website: BRAND_WEBSITE,
  location: BRAND_LOCATION,
  whatWeAre:
    "MailCall Newspaper is a monthly print newspaper sent directly to U.S. inmates, helping loved ones stay connected with news, education, and encouragement.",
  mission:
    "Our mission is to provide accurate, timely, and uplifting print journalism for incarcerated readers and the families who support them.",
  locationSpoken:
    "We serve families and facilities across the United States with a monthly print newspaper mailed directly to inmates.",
  officeAddressSpoken:
    "Mail Call Communication's administrative office is based in Abbottabad, Pakistan. For current mailing instructions, contact support at mailcallnewspaper dot com.",
  leadershipSpoken:
    "MailCall Newspaper is led by its publishing and administrative team, serving incarcerated readers and their families. Current leadership details are maintained in our About information.",
  advertiseSpoken:
    "For advertising with MailCall Newspaper, contact support at mailcallnewspaper dot com and our administrative team will follow up.",
  contactSpoken: `You can reach us at ${SUPPORT_EMAIL_SPOKEN} for support and publication details.`,
  officeSpoken:
    "Our live team is available Monday through Friday, ten A.M. to five P.M. Eastern time, and I'm here to help you right now.",
} as const;

export const BRAND_SPOKEN_ANSWERS = {
  identity:
    "I'd be glad to tell you about that. MailCall Newspaper is a monthly print newspaper sent directly to U.S. inmates, with news, education, and encouragement for your loved one.",
  mission:
    "I'd be glad to tell you about that. MailCall is dedicated to accurate, timely journalism that helps families stay connected with someone who is incarcerated.",
  vision:
    "I'd be glad to tell you about that. Our vision is a world where every incarcerated person can stay informed, hopeful, and connected to the people who care about them through a trusted monthly newspaper.",
  location:
    "I'd be glad to tell you about that. We mail our print newspaper to facilities across the United States.",
  officeAddress:
    "I'd be glad to help. Mail Call Communication's administrative office is based in Abbottabad, Pakistan. For current mailing instructions, contact support at mailcallnewspaper dot com.",
  leadership:
    "I'd be glad to help. MailCall Newspaper is led by its publishing and administrative team, serving incarcerated readers and their families.",
  advertise:
    "I'd be glad to help with advertising. Contact support at mailcallnewspaper dot com and our administrative team will follow up.",
  contact: `I'd be glad to tell you about that. You can reach us at ${SUPPORT_EMAIL_SPOKEN}, and our live team is available weekdays ten to five Eastern.`,
  general:
    "I'd be glad to tell you about that. Mail Call Communication's MailCall Newspaper sends a monthly print paper directly to U.S. inmates. How else can I help you today?",
  offTopic: SCRIPTS.offTopic,
} as const;

const IDENTITY_RE =
  /\b(who are you|what (is|are) (mail ?call|this|your)|tell me about (mail ?call|yourself|the (paper|newspaper|publication))|about (the )?(paper|newspaper|publication|mail ?call)|what do you (do|cover)|introduce)\b/i;
const VISION_RE = /\b(vision|future|aspire|what you (hope|want) (for|to))\b/i;
const MISSION_RE =
  /\b(mission|purpose|why (do )?you|what('s| is) your (goal|aim)|dedicated to)\b/i;
const LOCATION_RE =
  /\b(where (are|is) you|location|based|office hours|what time|are you open)\b/i;
const CONTACT_RE =
  /\b(contact|phone|email|reach you|website|web ?site|how (can|do) i (reach|contact))\b/i;

export function matchBrandProfileQuery(utterance: string): string | null {
  const q = normalizeVoiceTranscript(utterance);
  if (!q) return null;

  if (LOCATION_RE.test(q)) return BRAND_SPOKEN_ANSWERS.location;
  if (CONTACT_RE.test(q)) return BRAND_SPOKEN_ANSWERS.contact;
  if (VISION_RE.test(q)) return BRAND_SPOKEN_ANSWERS.vision;
  if (MISSION_RE.test(q)) return BRAND_SPOKEN_ANSWERS.mission;
  if (IDENTITY_RE.test(q)) return BRAND_SPOKEN_ANSWERS.identity;

  if (/^about\b/i.test(q) && /mail\s*call/i.test(q)) {
    return BRAND_SPOKEN_ANSWERS.identity;
  }

  return null;
}

export function brandOfflineFallbackSpeech(utterance: string): string {
  return matchBrandProfileQuery(utterance) ?? BRAND_SPOKEN_ANSWERS.general;
}

export function buildBrandProfileKnowledgeBlock(): string {
  return [
    "BRAND PROFILE (authoritative local copy — speak naturally from this):",
    `Name: ${BRAND_PROFILE.name} / MailCall Newspaper`,
    `About: ${BRAND_PROFILE.whatWeAre}`,
    `Mission: ${BRAND_PROFILE.mission}`,
    `Vision: ${BRAND_SPOKEN_ANSWERS.vision}`,
    `Service area: ${BRAND_PROFILE.locationSpoken}`,
    `Office fallback: ${BRAND_PROFILE.officeAddressSpoken}`,
    `Leadership fallback: ${BRAND_PROFILE.leadershipSpoken}`,
    `Advertising fallback: ${BRAND_PROFILE.advertiseSpoken}`,
    `Contact: ${BRAND_PROFILE.contactSpoken}`,
    "Do not invent other facts. Keep replies to 2–3 short spoken sentences.",
  ].join("\n");
}

export function offTopicRedirectSpeech(): string {
  return BRAND_SPOKEN_ANSWERS.offTopic;
}
