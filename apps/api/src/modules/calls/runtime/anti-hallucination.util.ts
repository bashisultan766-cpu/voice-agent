import type { VoiceTurnToolTrace } from './voice-turn-tool-trace.util';

export type GroundedProductFact = {
  title: string;
  price?: string | null;
};

export type HallucinationCheckResult = {
  suspected: boolean;
  reasons: string[];
  safeFallback?: string;
};

/** Build allow-list of product titles/prices from tool trace and session memory. */
export function groundedFactsFromTrace(
  trace: VoiceTurnToolTrace | undefined,
  memoryTitles: string[] = [],
): GroundedProductFact[] {
  const facts: GroundedProductFact[] = [];
  const sp = trace?.searchProducts;
  if (sp?.ok && sp.title) {
    facts.push({ title: sp.title, price: sp.price ?? null });
  }
  for (const t of memoryTitles) {
    if (t.trim()) facts.push({ title: t.trim() });
  }
  return facts;
}

/** Detect invented product titles or prices not present in grounded facts. */
export function detectHallucinatedProductClaims(
  reply: string,
  grounded: GroundedProductFact[],
): HallucinationCheckResult {
  const reasons: string[] = [];
  const allowedTitles = new Set(grounded.map((g) => g.title.toLowerCase().trim()).filter(Boolean));
  const allowedPrices = new Set(
    grounded.map((g) => g.price?.trim()).filter((p): p is string => Boolean(p)),
  );

  const foundProductPhrase = reply.match(/\b(?:i found|we have|there is|it's|it is)\s+([^.;!?]{3,80})/gi);
  if (foundProductPhrase && allowedTitles.size === 0) {
    reasons.push('product_claim_without_tool_grounding');
  }

  if (allowedTitles.size > 0 && foundProductPhrase) {
    for (const m of foundProductPhrase) {
      const chunk = m.replace(/^[^.]+\s+/i, '').toLowerCase();
      const matchesKnown = [...allowedTitles].some((t) => chunk.includes(t) || t.includes(chunk.slice(0, 20)));
      if (!matchesKnown && chunk.length > 8) {
        reasons.push('ungrounded_product_title');
        break;
      }
    }
  }

  const priceMentions = reply.match(/\$[\d,.]+(?:\s*(?:usd|dollars?))?/gi) ?? [];
  for (const p of priceMentions) {
    const norm = p.replace(/\s+/g, '');
    const ok = [...allowedPrices].some((ap) => ap && norm.includes(ap.replace(/\s+/g, '')));
    if (!ok && allowedPrices.size > 0) {
      reasons.push('ungrounded_price');
      break;
    }
    if (!ok && allowedPrices.size === 0 && priceMentions.length > 0) {
      reasons.push('price_without_tool');
    }
  }

  const invClaims = /\b(\d+)\s+(in stock|left|available)\b/i.test(reply);
  if (invClaims && allowedTitles.size === 0) {
    reasons.push('inventory_without_tool');
  }

  return {
    suspected: reasons.length > 0,
    reasons,
    safeFallback:
      reasons.length > 0
        ? "I don't have verified catalog details for that yet—let me search the store, or tell me the exact title or ISBN."
        : undefined,
  };
}

export function applyAntiHallucinationGuard(
  reply: string,
  trace: VoiceTurnToolTrace | undefined,
  memoryTitles: string[] = [],
): { reply: string; hallucinationAttempt: boolean; reasons: string[] } {
  const grounded = groundedFactsFromTrace(trace, memoryTitles);
  const check = detectHallucinatedProductClaims(reply, grounded);
  if (!check.suspected || !check.safeFallback) {
    return { reply, hallucinationAttempt: false, reasons: [] };
  }
  return {
    reply: check.safeFallback,
    hallucinationAttempt: true,
    reasons: check.reasons,
  };
}
