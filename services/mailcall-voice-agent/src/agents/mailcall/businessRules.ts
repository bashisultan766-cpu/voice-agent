/**
 * Brook — MailCall Newspaper business rules, product catalog, and office hours.
 * Spoken copy only — no technical jargon.
 */

export const AGENT_FIRST_NAME = "Brook";
export const AGENT_TITLE = "Senior Editorial & Customer Support Representative";
export const PUBLICATION_NAME = "MailCall Newspaper";
export const SUPPORT_EMAIL_SPOKEN = "support at mailcallnewspaper dot com";
export const SUPPORT_EMAIL = "support@mailcallnewspaper.com";

/** Default Send Newspaper / register checkout page (overridable via env). */
export const DEFAULT_CHECKOUT_URL = "https://mailcallnewspaper.com/register";

/** Eastern Time office hours: Mon–Fri 10:00–17:00. */
export const OFFICE_HOURS = {
  timeZone: "America/New_York",
  weekdays: [1, 2, 3, 4, 5] as const, // Mon–Fri (JS getDay: 0=Sun)
  openHour: 10,
  closeHour: 17,
  minCallDurationMsForTransfer: 5 * 60 * 1000,
} as const;

export interface MailCallPlan {
  sku: string;
  label: string;
  months: number;
  priceUsd: number;
  priceSpoken: string;
}

/** Authoritative baseline — used when live WordPress pricing is unavailable. */
export const MAILCALL_PLANS: MailCallPlan[] = [
  {
    sku: "MC-1M",
    label: "1-Month Plan",
    months: 1,
    priceUsd: 19.99,
    priceSpoken: "nineteen dollars and ninety-nine cents",
  },
  {
    sku: "MC-3M",
    label: "3-Month Plan",
    months: 3,
    priceUsd: 53.97,
    priceSpoken: "fifty-three dollars and ninety-seven cents",
  },
  {
    sku: "MC-6M",
    label: "6-Month Plan",
    months: 6,
    priceUsd: 95.94,
    priceSpoken: "ninety-five dollars and ninety-four cents",
  },
  {
    sku: "MC-12M",
    label: "12-Month Plan",
    months: 12,
    priceUsd: 179.88,
    priceSpoken: "one hundred seventy-nine dollars and eighty-eight cents",
  },
];

export const PUBLICATION_CATEGORIES = ["Urban", "Spanish", "Global"] as const;
export type PublicationCategory = (typeof PUBLICATION_CATEGORIES)[number];

export const PACKAGE_TYPES = [
  "Single Edition",
  "Bundle of Two",
  "Bundle of Three",
] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];

export const PRODUCT_INCLUSIONS_SPOKEN =
  "Each month we send a twenty-four-page newspaper designed exclusively for inmates across the U.S. It includes celebrity gossip and real news, inmate and sentencing updates, education and skill building, financial literacy, books and movies, music, comics, LGBTQ+ culture, health, fitness, Spanish content, travel, horoscopes, how-to guides, technology, sports, and pop culture.";

export const SCRIPTS = {
  goodbye:
    "You're very welcome. Thanks for calling MailCall Newspaper. Goodbye.",
  refundFinal:
    "Because our newspaper prints and submits directly to publishers immediately after ordering, our publisher does not permit returns or cancellations once processed. All sales are final.",
  delayedDelivery:
    "I completely understand your concern. Because MailCall is a print newspaper, delivery depends on both U.S.P.S. and the facility's mailroom. While we aim to have each issue arrive on time, delays can happen due to holidays, mailroom lockdowns, or processing times.",
  escalation:
    "I really hear your frustration, and I want to help. While our refund policy is strict due to printing costs, I can escalate this to our support manager or look into a delivery issue personally. Would you like me to do that?",
  checkoutLinkSent:
    "I just sent the order link to your email. Open that link to enter your details, the inmate's name, facility information, and complete your purchase on our Send Newspaper page.",
  checkoutAlreadySent:
    "I've already sent the checkout link to your email inbox. Please check it. Would you like me to resend it?",
  checkoutResent:
    "I've resent the order link to your email. Please check your inbox, and if needed your spam folder.",
  privacyBoundary:
    "For privacy and facility security, I do not collect inmate names, inmate numbers, facility names, or facility addresses over the phone. Those details are entered on our Send Newspaper page.",
  addressChange:
    `Address changes are free. Please email the updated details to ${SUPPORT_EMAIL_SPOKEN}. The facility mailroom usually forwards mail for up to thirty days, and you should confirm the new facility accepts printed newspapers.`,
  firstIssueTimeline:
    "Issues ship monthly, and the first issue usually arrives within two to four weeks.",
  afterHours:
    "Our live agents are available Monday through Friday, ten A.M. to five P.M. Eastern time. I'm happy to keep helping you right now, or you can leave a message at support at mailcallnewspaper dot com and we'll follow up on the next business day.",
  transferNotReady:
    "I'd be glad to connect you with a live teammate once we've had a few more minutes together, and only during weekday office hours. How else can I help you in the meantime?",
  voicemail:
    "You're welcome to leave a detailed message for our team at support at mailcallnewspaper dot com, including your name and the best callback number. We'll return your call on the next business day.",
  offTopic:
    "I'm here to help with MailCall Newspaper — subscriptions, deliveries, and support for loved ones. How can I assist you with MailCall today?",
} as const;

/** Parts in America/New_York for a given instant. */
export function getEasternParts(now: Date = new Date()): {
  weekday: number;
  hour: number;
  minute: number;
  dateLabel: string;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: OFFICE_HOURS.timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayMap[parts.weekday ?? ""] ?? now.getUTCDay();
  const hour = Number.parseInt(parts.hour ?? "0", 10);
  const minute = Number.parseInt(parts.minute ?? "0", 10);
  return {
    weekday,
    hour: Number.isFinite(hour) ? hour % 24 : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    dateLabel: `${parts.weekday ?? ""} ${parts.month ?? ""} ${parts.day ?? ""}, ${parts.year ?? ""}`.trim(),
  };
}

export function isWithinOfficeHours(now: Date = new Date()): boolean {
  const { weekday, hour } = getEasternParts(now);
  if (!(OFFICE_HOURS.weekdays as readonly number[]).includes(weekday)) return false;
  return hour >= OFFICE_HOURS.openHour && hour < OFFICE_HOURS.closeHour;
}

export function canTransferToLiveAgent(opts: {
  callStartedAtMs: number;
  nowMs?: number;
  transferNumberConfigured: boolean;
}): { allowed: boolean; reasonSpoken: string } {
  const nowMs = opts.nowMs ?? Date.now();
  if (!opts.transferNumberConfigured) {
    return { allowed: false, reasonSpoken: SCRIPTS.afterHours };
  }
  if (!isWithinOfficeHours(new Date(nowMs))) {
    return { allowed: false, reasonSpoken: SCRIPTS.afterHours };
  }
  if (nowMs - opts.callStartedAtMs < OFFICE_HOURS.minCallDurationMsForTransfer) {
    return { allowed: false, reasonSpoken: SCRIPTS.transferNotReady };
  }
  return { allowed: true, reasonSpoken: "Not a problem — I'll connect you with a live teammate now." };
}

export function findPlanBySku(sku: string): MailCallPlan | undefined {
  const cleaned = sku.trim().toUpperCase().replace(/\s+/g, "");
  return MAILCALL_PLANS.find(
    (p) =>
      p.sku === cleaned ||
      p.sku.replace("-", "") === cleaned ||
      `${p.months}M` === cleaned ||
      `${p.months}-MONTH` === cleaned,
  );
}

export function findPlanByUtterance(utterance: string): MailCallPlan | undefined {
  const u = utterance.toLowerCase();
  if (/\b12[- ]?month|one year|yearly|annual\b/.test(u)) return MAILCALL_PLANS[3];
  if (/\b6[- ]?month|six month\b/.test(u)) return MAILCALL_PLANS[2];
  if (/\b3[- ]?month|three month|quarterly\b/.test(u)) return MAILCALL_PLANS[1];
  if (/\b1[- ]?month|one month|monthly plan\b/.test(u)) return MAILCALL_PLANS[0];
  return undefined;
}

export function buildProductCatalogSpeech(focusSku?: string): string {
  const focused = focusSku ? findPlanBySku(focusSku) : undefined;
  if (focused) {
    return (
      `I can help with that. The ${focused.label} is ${focused.priceSpoken}. ` +
      `We offer Urban, Spanish, and Global publications, plus Single Edition, Bundle of Two, or Bundle of Three packages. ` +
      PRODUCT_INCLUSIONS_SPOKEN
    );
  }
  return (
    "I can help with that. Our plans are one month for nineteen ninety-nine, " +
    "three months for fifty-three ninety-seven, six months for ninety-five ninety-four, " +
    "and twelve months for one hundred seventy-nine eighty-eight. " +
    "Publications are Urban, Spanish, and Global. Packages are Single Edition, Bundle of Two, or Bundle of Three. " +
    PRODUCT_INCLUSIONS_SPOKEN
  );
}

export function buildBusinessKnowledgeBlock(now: Date = new Date()): string {
  const eastern = getEasternParts(now);
  const open = isWithinOfficeHours(now);
  return [
    "BUSINESS RULES (authoritative — speak naturally from this):",
    `Agent: ${AGENT_FIRST_NAME}, ${AGENT_TITLE} at ${PUBLICATION_NAME}.`,
    `Current Eastern reference: ${eastern.dateLabel}, about ${eastern.hour}:${String(eastern.minute).padStart(2, "0")} Eastern. Office open now: ${open ? "yes" : "no"}.`,
    "Office hours: Monday–Friday 10:00 AM–5:00 PM Eastern. Closed weekends and major U.S. holidays.",
    "Transfer: only when office is open AND call has lasted over 5 minutes.",
    "Refunds: ALL SALES ARE FINAL — never promise refunds, credits, or cancellations.",
    SCRIPTS.refundFinal,
    `Address changes: free — email ${SUPPORT_EMAIL}.`,
    SCRIPTS.firstIssueTimeline,
    "PRIVACY: Never collect inmate name, inmate number, facility name, or facility address over the phone.",
    "Conversion: on purchase intent, ask only for contact email, confirm it, then email the Send Newspaper order link. Do not interrogate about plans or packages before sending the link.",
    "Duplicate sends: after a successful send, do not email again unless the caller explicitly confirms a resend.",
    "Publication categories: Urban, Spanish, Global.",
    "Package types: Single Edition, Bundle of Two, Bundle of Three.",
    "Plans:",
    ...MAILCALL_PLANS.map((p) => `- ${p.sku}: ${p.label} = $${p.priceUsd.toFixed(2)}`),
    PRODUCT_INCLUSIONS_SPOKEN,
  ].join("\n");
}
