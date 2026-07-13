/**
 * Proactive sales / Smart Suggest — one cross-sell after a successful cart add.
 * Uses series / genre / author tags & metafields; never invents titles.
 */
import type { CallSession } from "../types/order.js";
import { ensureShoppingCart } from "./cartManager.js";

export interface RecommendationCandidate {
  title: string;
  variantId: string;
  tags?: string[];
  metafields?: Array<{ namespace: string; key: string; value: string }>;
  price?: string;
}

export interface ProactiveRecommendation {
  title: string;
  variantId: string;
  matchReason: "series" | "genre" | "author";
  affinityLabel: string;
  speech: string;
}

export interface ProductAffinity {
  series: string[];
  genre: string[];
  author: string[];
}

function norm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushUnique(list: string[], value: string): void {
  const n = norm(value);
  if (!n || list.includes(n)) return;
  list.push(n);
}

/** Extract series / genre / author affinity keys from Shopify tags + metafields. */
export function extractProductAffinity(
  tags?: string[],
  metafields?: Array<{ namespace: string; key: string; value: string }>,
): ProductAffinity {
  const series: string[] = [];
  const genre: string[] = [];
  const author: string[] = [];

  for (const tag of tags ?? []) {
    const t = tag.trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    const seriesMatch = lower.match(/^(?:series[:_\s-]+)(.+)$/i);
    const genreMatch = lower.match(/^(?:genre[:_\s-]+)(.+)$/i);
    const authorMatch = lower.match(/^(?:author[:_\s-]+)(.+)$/i);
    if (seriesMatch?.[1]) pushUnique(series, seriesMatch[1]);
    else if (genreMatch?.[1]) pushUnique(genre, genreMatch[1]);
    else if (authorMatch?.[1]) pushUnique(author, authorMatch[1]);
  }

  for (const mf of metafields ?? []) {
    const key = (mf.key ?? "").toLowerCase();
    const value = (mf.value ?? "").trim();
    if (!value) continue;
    if (key === "series" || key.endsWith(".series") || key.includes("series")) {
      pushUnique(series, value);
    } else if (key === "genre" || key.endsWith(".genre") || key.includes("genre")) {
      pushUnique(genre, value);
    } else if (
      key === "author" ||
      key === "writer" ||
      key.endsWith(".author") ||
      key.includes("author")
    ) {
      pushUnique(author, value);
    }
  }

  return { series, genre, author };
}

function sharedAffinity(
  a: ProductAffinity,
  b: ProductAffinity,
): { reason: "series" | "genre" | "author"; label: string; score: number } | null {
  for (const s of a.series) {
    if (b.series.includes(s)) return { reason: "series", label: s, score: 30 };
  }
  for (const g of a.genre) {
    if (b.genre.includes(g)) return { reason: "genre", label: g, score: 20 };
  }
  for (const au of a.author) {
    if (b.author.includes(au)) return { reason: "author", label: au, score: 10 };
  }
  return null;
}

export function buildProactiveSuggestionSpeech(
  addedTitle: string,
  recommendationTitle: string,
  matchReason: "series" | "genre" | "author",
): string {
  const interest =
    matchReason === "series"
      ? "that series"
      : matchReason === "genre"
        ? "that genre"
        : "that author";
  return (
    `I've added ${addedTitle} to your cart. Since you're interested in ${interest}, ` +
    `would you also like to add ${recommendationTitle} to your order?`
  );
}

/**
 * Smart Suggest — pick exactly one high-probability cross-sell not already in cart
 * and not previously declined this call. Returns null when metadata yields no match.
 */
export function getProactiveRecommendation(input: {
  addedSku: string;
  addedTitle: string;
  addedTags?: string[];
  addedMetafields?: Array<{ namespace: string; key: string; value: string }>;
  cartVariantIds: string[];
  declinedRecommendations?: string[];
  candidates: RecommendationCandidate[];
}): ProactiveRecommendation | null {
  const addedSku = (input.addedSku ?? "").trim();
  const addedTitle = (input.addedTitle ?? "").trim() || "that book";
  if (!addedSku && !addedTitle) return null;

  const sourceAffinity = extractProductAffinity(input.addedTags, input.addedMetafields);
  if (
    sourceAffinity.series.length === 0 &&
    sourceAffinity.genre.length === 0 &&
    sourceAffinity.author.length === 0
  ) {
    return null;
  }

  const cartIds = new Set(
    (input.cartVariantIds ?? []).map((id) => id.trim().toLowerCase()).filter(Boolean),
  );
  const declined = new Set(
    (input.declinedRecommendations ?? []).map((id) => id.trim().toLowerCase()).filter(Boolean),
  );
  cartIds.add(addedSku.toLowerCase());

  let best:
    | {
        candidate: RecommendationCandidate;
        reason: "series" | "genre" | "author";
        label: string;
        score: number;
      }
    | undefined;

  for (const candidate of input.candidates ?? []) {
    const variantId = (candidate.variantId ?? "").trim();
    const title = (candidate.title ?? "").trim();
    if (!variantId || !title) continue;
    const idKey = variantId.toLowerCase();
    const titleKey = title.toLowerCase();
    if (cartIds.has(idKey) || declined.has(idKey) || declined.has(titleKey)) continue;
    if (norm(title) === norm(addedTitle)) continue;

    const affinity = extractProductAffinity(candidate.tags, candidate.metafields);
    const match = sharedAffinity(sourceAffinity, affinity);
    if (!match) continue;
    if (!best || match.score > best.score) {
      best = { candidate, reason: match.reason, label: match.label, score: match.score };
    }
  }

  if (!best) return null;

  return {
    title: best.candidate.title,
    variantId: best.candidate.variantId,
    matchReason: best.reason,
    affinityLabel: best.label,
    speech: buildProactiveSuggestionSpeech(addedTitle, best.candidate.title, best.reason),
  };
}

/** Snake_case alias for tool / workflow docs. */
export const get_proactive_recommendation = getProactiveRecommendation;

export function ensureDeclinedRecommendations(session: CallSession): string[] {
  if (!session.sessionDeclinedRecommendations) {
    session.sessionDeclinedRecommendations = [];
  }
  return session.sessionDeclinedRecommendations;
}

export function recordDeclinedRecommendation(
  session: CallSession,
  variantIdOrTitle: string,
): void {
  const key = variantIdOrTitle.trim();
  if (!key) return;
  const list = ensureDeclinedRecommendations(session);
  const lower = key.toLowerCase();
  if (!list.some((entry) => entry.toLowerCase() === lower)) {
    list.push(key);
  }
  session.pendingProactiveRecommendation = undefined;
}

export function clearPendingProactiveRecommendation(session: CallSession): void {
  session.pendingProactiveRecommendation = undefined;
}

export function resolveRecommendationCandidates(session: CallSession): RecommendationCandidate[] {
  const fromPool = session.recommendationCatalog ?? [];
  const fromSimilar = (session.lastCatalogSearch?.similarMatches ?? []).map((m) => ({
    title: m.title,
    variantId: m.variantId,
    tags: m.tags,
    metafields: m.metafields,
    price: m.price,
  }));
  const byId = new Map<string, RecommendationCandidate>();
  for (const c of [...fromPool, ...fromSimilar]) {
    const id = (c.variantId ?? "").trim();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, c);
  }
  return [...byId.values()];
}

/** After a successful cart increase — attach one Smart Suggest or stay silent. */
export function attachProactiveRecommendationAfterAdd(
  session: CallSession,
  added: { sku: string; title: string; tags?: string[]; metafields?: Array<{ namespace: string; key: string; value: string }> },
): ProactiveRecommendation | null {
  const cartVariantIds = ensureShoppingCart(session).map((line) => line.variantId);
  const recommendation = getProactiveRecommendation({
    addedSku: added.sku,
    addedTitle: added.title,
    addedTags: added.tags ?? session.lastCatalogSearch?.tags,
    addedMetafields: added.metafields ?? session.lastCatalogSearch?.metafields,
    cartVariantIds,
    declinedRecommendations: ensureDeclinedRecommendations(session),
    candidates: resolveRecommendationCandidates(session),
  });

  if (!recommendation) {
    session.pendingProactiveRecommendation = undefined;
    return null;
  }

  session.pendingProactiveRecommendation = {
    title: recommendation.title,
    variantId: recommendation.variantId,
    addedTitle: added.title,
    matchReason: recommendation.matchReason,
  };
  return recommendation;
}

export function isProactiveRecommendationDecline(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return (
    /^(no|nope|nah|no thanks|no thank you|not now|not today|skip|pass)\b/i.test(t) ||
    /\b(don'?t add|do not add|not interested|no i don'?t|without (?:it|that))\b/i.test(t)
  );
}

export function isProactiveRecommendationAccept(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (isProactiveRecommendationDecline(t)) return false;
  return (
    /^(yes|yeah|yep|sure|ok|okay|please|absolutely)\b/i.test(t) ||
    /\b(add it|add that|yes please|go ahead|sounds good)\b/i.test(t)
  );
}
