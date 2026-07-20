/**
 * Dynamic product catalog for MailCall voice.
 * Prefer live WordPress categories/pricing when available; fall back to baseline rules.
 */

import {
  MAILCALL_PLANS,
  PACKAGE_TYPES,
  PUBLICATION_CATEGORIES,
  type MailCallPlan,
  type PackageType,
  type PublicationCategory,
} from "./businessRules.js";
import type { MailCallCategory } from "./types.js";

export interface MailCallCatalog {
  categories: PublicationCategory[];
  plans: MailCallPlan[];
  packages: PackageType[];
  /** True when plans came from live CMS parse rather than baseline. */
  plansFromCms: boolean;
  /** True when categories were confirmed/merged from WordPress. */
  categoriesFromCms: boolean;
  sourceLabel: "wordpress" | "baseline" | "mixed";
}

const PRICE_PATTERNS: Array<{ months: number; re: RegExp }> = [
  { months: 1, re: /(?:1[\s-]*month|one[\s-]*month)[^\d$]{0,40}\$?\s*(19\.99|21\.66)/i },
  { months: 3, re: /(?:3[\s-]*month|three[\s-]*month)[^\d$]{0,40}\$?\s*(53\.97|59\.99)/i },
  { months: 6, re: /(?:6[\s-]*month|six[\s-]*month)[^\d$]{0,40}\$?\s*(95\.94|119(?:\.00)?)/i },
  {
    months: 12,
    re: /(?:12[\s-]*month|twelve[\s-]*month|one[\s-]*year|annual)[^\d$]{0,40}\$?\s*(179\.88|229(?:\.00)?)/i,
  },
];

function moneySpoken(amount: number): string {
  const dollars = Math.floor(amount);
  const cents = Math.round((amount - dollars) * 100);
  const dollarWords: Record<number, string> = {
    19: "nineteen",
    21: "twenty-one",
    53: "fifty-three",
    59: "fifty-nine",
    95: "ninety-five",
    119: "one hundred nineteen",
    179: "one hundred seventy-nine",
    229: "two hundred twenty-nine",
  };
  const centsWords: Record<number, string> = {
    0: "",
    66: "sixty-six",
    88: "eighty-eight",
    94: "ninety-four",
    97: "ninety-seven",
    99: "ninety-nine",
  };
  const d = dollarWords[dollars] ?? `${dollars}`;
  const c = centsWords[cents];
  if (!cents) return `${d} dollars`;
  if (c) return `${d} dollars and ${c} cents`;
  return `${d} dollars and ${cents} cents`;
}

function withSpokenPrice(plan: MailCallPlan, priceUsd: number): MailCallPlan {
  return {
    ...plan,
    priceUsd,
    priceSpoken: moneySpoken(priceUsd),
  };
}

/** Map WP category names onto Urban / Spanish / Global when present. */
export function resolvePublicationCategories(
  wpCategories: MailCallCategory[] = [],
): { categories: PublicationCategory[]; fromCms: boolean } {
  if (wpCategories.length === 0) {
    return { categories: [...PUBLICATION_CATEGORIES], fromCms: false };
  }

  const names = wpCategories.map((c) => c.name.toLowerCase());
  const found: PublicationCategory[] = [];
  for (const cat of PUBLICATION_CATEGORIES) {
    if (names.some((n) => n.includes(cat.toLowerCase()))) {
      found.push(cat);
    }
  }

  if (found.length === 0) {
    return { categories: [...PUBLICATION_CATEGORIES], fromCms: false };
  }
  // Keep authoritative order; fill any missing baseline categories.
  const ordered = PUBLICATION_CATEGORIES.filter(
    (c) => found.includes(c) || found.length < PUBLICATION_CATEGORIES.length,
  );
  return {
    categories: ordered.length > 0 ? [...PUBLICATION_CATEGORIES] : found,
    fromCms: found.length > 0,
  };
}

/** Parse plan prices from free-form WordPress page/post text when present. */
export function parsePlansFromCmsText(rawText: string): MailCallPlan[] | null {
  const text = String(rawText ?? "");
  if (!text.trim()) return null;

  const updates = new Map<number, number>();
  for (const { months, re } of PRICE_PATTERNS) {
    const match = text.match(re);
    if (match?.[1]) {
      const price = Number.parseFloat(match[1]);
      if (Number.isFinite(price) && price > 0) updates.set(months, price);
    }
  }

  if (updates.size === 0) return null;

  return MAILCALL_PLANS.map((plan) => {
    const live = updates.get(plan.months);
    return live !== undefined ? withSpokenPrice(plan, live) : plan;
  });
}

export function buildCatalog(input?: {
  wpCategories?: MailCallCategory[];
  cmsPricingText?: string;
}): MailCallCatalog {
  const { categories, fromCms: categoriesFromCms } = resolvePublicationCategories(
    input?.wpCategories,
  );
  const parsed = input?.cmsPricingText
    ? parsePlansFromCmsText(input.cmsPricingText)
    : null;
  const plans = parsed ?? MAILCALL_PLANS;
  const plansFromCms = Boolean(parsed);

  let sourceLabel: MailCallCatalog["sourceLabel"] = "baseline";
  if (plansFromCms && categoriesFromCms) sourceLabel = "wordpress";
  else if (plansFromCms || categoriesFromCms) sourceLabel = "mixed";

  return {
    categories,
    plans,
    packages: [...PACKAGE_TYPES],
    plansFromCms,
    categoriesFromCms,
    sourceLabel,
  };
}

export function catalogKnowledgeBlock(catalog: MailCallCatalog): string {
  return [
    "ACTIVE CATALOG (prefer these values for this turn):",
    `Source: ${catalog.sourceLabel}.`,
    `Publications: ${catalog.categories.join(", ")}.`,
    `Packages: ${catalog.packages.join("; ")}.`,
    "Plans:",
    ...catalog.plans.map((p) => `- ${p.sku}: ${p.label} = $${p.priceUsd.toFixed(2)}`),
  ].join("\n");
}
