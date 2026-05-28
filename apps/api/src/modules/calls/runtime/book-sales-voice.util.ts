/**
 * SureShot Books phone sales: inbound greeting, product voice lines, banned phrases.
 */

export const SURESHOT_INBOUND_GREETING =
  'Hello, this is Justin with SureShot Books. How can I help you find or order a book today?';

export const BOOK_NEED_PROMPT =
  'Absolutely. Are you looking for a specific title, author, or a category like history, romance, religion, or fiction?';

export const QUANTITY_PROMPT = 'Perfect. How many copies would you like to order?';

export const EMAIL_COLLECTION_PROMPT =
  'Great. Please share your email address, and I’ll send you the payment link.';

const BOOK_CATEGORY_KEYWORDS: Record<string, string[]> = {
  history: ['history', 'historical', 'world war', 'civil war'],
  romance: ['romance', 'romantic', 'love story'],
  religion: ['religion', 'religious', 'faith', 'christian', 'bible', 'spiritual'],
  fiction: ['fiction', 'novel', 'fantasy', 'sci-fi', 'science fiction', 'mystery', 'thriller'],
  biography: ['biography', 'memoir', 'autobiography'],
  self_help: ['self help', 'self-help', 'personal development'],
};

export function resolveInboundGreetingText(agentGreeting?: string | null): string {
  const custom = agentGreeting?.trim();
  return custom && custom.length > 0 ? custom : SURESHOT_INBOUND_GREETING;
}

/** Whether inbound TwiML should attempt ElevenLabs greeting playback. */
export function shouldPlayInboundElevenLabsGreeting(opts: {
  hearingDebug: boolean;
  forceElevenLabsOnly: boolean;
  voiceId?: string | null;
  publicOrigin: string;
}): boolean {
  const vid = opts.voiceId?.trim();
  return (
    (!opts.hearingDebug || opts.forceElevenLabsOnly) &&
    Boolean(vid) &&
    /^https:\/\//i.test(opts.publicOrigin)
  );
}

export function formatVoiceUsd(price: string | null | undefined): string | null {
  if (price == null || price === '') return null;
  const n = Number(String(price).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export type VoiceProductOfferInput = {
  title: string;
  variants: Array<{
    price?: string | null;
    inventory_quantity?: number;
    availableForSale?: boolean;
  }>;
};

export function pickPrimaryVariant(variants: VoiceProductOfferInput['variants']) {
  if (!variants.length) return null;
  const inStock = variants.find(
    (v) => (v.inventory_quantity ?? 0) > 0 || v.availableForSale === true,
  );
  return inStock ?? variants.find((v) => v.price) ?? variants[0];
}

export function totalInventory(variants: VoiceProductOfferInput['variants']): number | null {
  if (!variants.length) return null;
  let sum = 0;
  let any = false;
  for (const v of variants) {
    if (typeof v.inventory_quantity === 'number') {
      sum += Math.max(0, v.inventory_quantity);
      any = true;
    }
  }
  return any ? sum : null;
}

/** Single-title found — always includes price; stock when known. */
export function formatProductFoundVoiceSummary(product: VoiceProductOfferInput): string {
  const title = product.title.trim();
  const variant = pickPrimaryVariant(product.variants);
  const priceSpoken = formatVoiceUsd(variant?.price ?? null);
  const stock = totalInventory(product.variants);

  if (priceSpoken && stock != null) {
    const copies = stock === 1 ? '1 copy' : `${stock} copies`;
    return `Yes, we have ${title} available. It is priced at ${priceSpoken} per copy, and we currently have ${copies} available. Would you like to order it?`;
  }
  if (priceSpoken) {
    return `Yes, we have ${title} available. It is priced at ${priceSpoken} per copy. Would you like to order it?`;
  }
  return `Yes, we have ${title} available. Would you like to order it?`;
}

/** Low-confidence / similar match — still include price when possible. */
export function formatSimilarProductVoiceSummary(product: VoiceProductOfferInput): string {
  const variant = pickPrimaryVariant(product.variants);
  const priceSpoken = formatVoiceUsd(variant?.price ?? null);
  const title = product.title.trim();
  if (priceSpoken) {
    return `I found something close: ${title}, priced at ${priceSpoken}. Is that the book you meant?`;
  }
  return `I found something similar: ${title}. Is that the one you meant?`;
}

function stockPhrase(stock: number | null): string {
  if (stock == null) return '';
  if (stock <= 0) return ', currently out of stock';
  return `, with ${stock === 1 ? '1 copy' : `${stock} copies`} available`;
}

/** Up to three category/browse hits with price (and stock when known). */
export function formatCategorySearchVoiceSummary(
  categoryLabel: string,
  products: VoiceProductOfferInput[],
): string {
  const top = products.slice(0, 3);
  if (top.length === 0) {
    return `I couldn't find books in ${categoryLabel} right now. Could you try another category or a specific title?`;
  }
  const parts: string[] = [];
  top.forEach((p, i) => {
    const variant = pickPrimaryVariant(p.variants);
    const price = formatVoiceUsd(variant?.price ?? null);
    const stock = totalInventory(p.variants);
    const ord = i === 0 ? 'first' : i === 1 ? 'second' : 'third';
    const priceBit = price ? `, priced at ${price}` : '';
    parts.push(`the ${ord} is ${p.title.trim()}${priceBit}${stockPhrase(stock)}`);
  });
  return `I found a few options in ${categoryLabel}. ${parts.join('. ')}. Which one would you like?`;
}

export function detectBookCategoryQuery(text: string): string | null {
  const t = text.toLowerCase().replace(/[^\w\s-]/g, ' ');
  for (const [label, keywords] of Object.entries(BOOK_CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (t.includes(kw)) return label.replace(/_/g, ' ');
    }
  }
  if (/\b(history|romance|religion|fiction|biography|mystery|fantasy)\s+book\b/i.test(t)) {
    const m = t.match(/\b(history|romance|religion|fiction|biography|mystery|fantasy)\b/);
    return m?.[1] ?? null;
  }
  return null;
}

export function isGenericBookNeedUtterance(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  if (/\b(isbn|sku)\b/.test(t)) return false;
  if (/\b(do you have|looking for|find|search)\s+.{3,}/.test(t) && t.split(/\s+/).length >= 3) {
    return false;
  }
  return (
    /\b(i need a book|i want a book|need a book|want a book|do you have books|any books|looking for a book|book please)\b/.test(
      t,
    ) || /^(i need|i want)\s+(a|some)\s+books?\.?$/i.test(t)
  );
}

export function formatEmailConfirmationVoice(email: string): string {
  return `Thank you. I have your email as ${email}. I'll send the payment link there.`;
}

export function formatPaymentLinkPendingVoice(): string {
  return 'Perfect. Our team will send the payment link to your email shortly.';
}

const EXTRA_BANNED = [/\bdropshipping\b/gi, /\bdrop\s+shipping\b/gi];

export function sanitizeBookstoreVoicePhrases(text: string): string {
  let t = text.trim();
  for (const re of EXTRA_BANNED) {
    t = t.replace(re, ' ').replace(/\s+/g, ' ').trim();
  }
  return t;
}
