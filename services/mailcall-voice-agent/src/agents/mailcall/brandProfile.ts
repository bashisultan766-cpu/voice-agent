/**
 * Static local brand profile for MailCall Newspaper / Mail Call Communication.
 * Used for identity questions and when live CMS retrieval is offline.
 */

import { SCRIPTS, SUPPORT_EMAIL_SPOKEN } from "./businessRules.js";
import { normalizeVoiceTranscript } from "./textCleaner.js";

export const brandProfile = {
  name: "MailCall Newspaper",
  ceo: "Staff Management",
  address: "650 East Palisade Ave #429, Englewood Cliffs, New Jersey 07632",
  phone: "201.429.0422",
  email: "support@mailcallnewspaper.com",
  mission: "Keeping Inmates Connected, Informed & Empowered.",
} as const;

export const BRAND_NAME = brandProfile.name;
export const BRAND_WEBSITE = "https://mailcallnewspaper.com";
export const BRAND_LOCATION = brandProfile.address;

export const MAILCALL_ABOUT_US = {
  headline: "MailCall Newspaper: The Best Newspaper to Inmates",
  description:
    "MailCall Newspaper delivers essential news, entertainment, and educational content in an all-in-one publication designed exclusively for inmates across the U.S.",
  pageCount: 24,
  sections: [
    "Celebrity Gossip & Real News",
    "Inmate News & Sentencing Updates",
    "Education & Skill Building",
    "Financial Literacy & Investment Tips",
    "Prison Book Club & Movie Picks",
    "Music, Comics & LGBTQ+ Culture",
    "Health, Fitness & Motivation",
    "Spanish Content & Travel",
    "Horoscopes, How-To Guides & Tech",
    "Sports, Pop Culture & More",
  ],
  spanishTitle: "Periódico para Prisioneros",
  primaryTagline: "Your world. Your stories. Your connection.",
  vision:
    "We aim to provide content that not only informs but also inspires. From interactive RPG-style features to practical advice on building strong habits, managing money, and staying connected with loved ones, MailCall Newspaper is your trusted companion inside.",
  mission:
    "Our mission is simple: to educate, entertain, and empower. Every story, column, and feature is carefully curated to ensure our readers gain value with every page.",
  values:
    "Join thousands of inmates nationwide who rely on MailCall to stay connected to the world, learn new skills, and enjoy exclusive content they will not find anywhere else.",
  closingTagline: "Your Connection. Your Community. Your Voice.",
  callToAction: "Subscribe now.",
  socialPlatforms: ["Facebook", "X", "Instagram", "TikTok", "Tumblr", "Pinterest"],
  copyright:
    "Copyright © 2026 Newspaper For Inmates | Inmate-Focused, Family-Trusted",
} as const;

export const BRAND_PROFILE = {
  ...brandProfile,
  website: BRAND_WEBSITE,
  location: BRAND_LOCATION,
  whatWeAre:
    MAILCALL_ABOUT_US.description,
  locationSpoken:
    "We serve families and facilities across the United States with a monthly print newspaper mailed directly to inmates.",
  officeAddressSpoken: `MailCall Newspaper is located at ${brandProfile.address}.`,
  leadershipSpoken: `MailCall Newspaper is led by ${brandProfile.ceo}.`,
  advertiseSpoken:
    "For advertising with MailCall Newspaper, contact support at mailcallnewspaper dot com and our administrative team will follow up.",
  contactSpoken: `You can reach us at ${SUPPORT_EMAIL_SPOKEN}, or call ${brandProfile.phone}, for support and publication details.`,
  officeSpoken:
    "Our live team is available Monday through Friday, ten A.M. to five P.M. Eastern time, and I'm here to help you right now.",
} as const;

export const BRAND_SPOKEN_ANSWERS = {
  identity:
    "I'd be glad to tell you about that. MailCall Newspaper is a twenty-four-page all-in-one publication designed exclusively for inmates across the U.S., delivering essential news, entertainment, and educational content.",
  mission: `I'd be glad to tell you about that. ${MAILCALL_ABOUT_US.mission}`,
  vision: `I'd be glad to tell you about that. Our vision is this: ${MAILCALL_ABOUT_US.vision}`,
  values: `Thousands of inmates nationwide rely on MailCall to stay connected to the world, learn new skills, and enjoy exclusive content. ${MAILCALL_ABOUT_US.closingTagline}`,
  sections:
    "Our twenty-four-page edition includes celebrity gossip and real news, inmate and sentencing updates, education, financial literacy, books and movies, music, comics, LGBTQ+ culture, health, fitness, Spanish content, travel, horoscopes, how-to guides, technology, sports, and pop culture.",
  location: `I'd be glad to tell you about that. MailCall Newspaper is located at ${brandProfile.address}.`,
  officeAddress: `I'd be glad to help. MailCall Newspaper is located at ${brandProfile.address}.`,
  leadership: `I'd be glad to help. MailCall Newspaper is led by ${brandProfile.ceo}.`,
  advertise:
    "I'd be glad to help with advertising. Contact support at mailcallnewspaper dot com and our administrative team will follow up.",
  contact: `I'd be glad to tell you about that. You can reach us at ${SUPPORT_EMAIL_SPOKEN}, or call ${brandProfile.phone}.`,
  general:
    "I'd be glad to tell you about that. Mail Call Communication's MailCall Newspaper sends a monthly print paper directly to U.S. inmates. How else can I help you today?",
  offTopic: SCRIPTS.offTopic,
} as const;

const IDENTITY_RE =
  /\b(who are you|what (is|are) (mail ?call|this|your)|tell me about (mail ?call|yourself|the (paper|newspaper|publication))|about (the )?(paper|newspaper|publication|mail ?call)|what do you (do|cover)|introduce)\b/i;
const VISION_RE = /\b(vision|future|aspire|what you (hope|want) (for|to))\b/i;
const MISSION_RE =
  /\b(mission|purpose|why (do )?you|what('s| is) your (goal|aim)|dedicated to)\b/i;
const VALUES_RE = /\b(values?|principles?|what (do )?you stand for)\b/i;
const CONTENT_RE =
  /\b(what('s| is) inside|sections?|content|topics?|cover(age)?|twenty[- ]?four|24[- ]?page)\b/i;
const LOCATION_RE =
  /\b(where (are|is) you|address|location|based|office hours|what time|are you open)\b/i;
const CONTACT_RE =
  /\b(contact|phone|email|reach you|website|web ?site|how (can|do) i (reach|contact))\b/i;

export function matchBrandProfileQuery(utterance: string): string | null {
  const q = normalizeVoiceTranscript(utterance);
  if (!q) return null;

  if (LOCATION_RE.test(q)) return BRAND_SPOKEN_ANSWERS.location;
  if (CONTACT_RE.test(q)) return BRAND_SPOKEN_ANSWERS.contact;
  if (VALUES_RE.test(q)) return BRAND_SPOKEN_ANSWERS.values;
  if (CONTENT_RE.test(q)) return BRAND_SPOKEN_ANSWERS.sections;
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
    `CEO: ${BRAND_PROFILE.ceo}`,
    `Headline: ${MAILCALL_ABOUT_US.headline}`,
    `About: ${MAILCALL_ABOUT_US.description}`,
    `Format: ${MAILCALL_ABOUT_US.pageCount}-page edition`,
    `Sections: ${MAILCALL_ABOUT_US.sections.join("; ")}`,
    `Spanish identity: ${MAILCALL_ABOUT_US.spanishTitle}`,
    `Primary tagline: ${MAILCALL_ABOUT_US.primaryTagline}`,
    `Mission: ${MAILCALL_ABOUT_US.mission}`,
    `Vision: ${MAILCALL_ABOUT_US.vision}`,
    `Values: ${MAILCALL_ABOUT_US.values}`,
    `Closing tagline: ${MAILCALL_ABOUT_US.closingTagline}`,
    `Call to action: ${MAILCALL_ABOUT_US.callToAction}`,
    `Service area: ${BRAND_PROFILE.locationSpoken}`,
    `Office fallback: ${BRAND_PROFILE.officeAddressSpoken}`,
    `Phone: ${BRAND_PROFILE.phone}`,
    `Email: ${BRAND_PROFILE.email}`,
    `Leadership fallback: ${BRAND_PROFILE.leadershipSpoken}`,
    `Advertising fallback: ${BRAND_PROFILE.advertiseSpoken}`,
    `Contact: ${BRAND_PROFILE.contactSpoken}`,
    "Do not invent other facts. Keep replies to 2–3 short spoken sentences.",
  ].join("\n");
}

export function offTopicRedirectSpeech(): string {
  return BRAND_SPOKEN_ANSWERS.offTopic;
}
