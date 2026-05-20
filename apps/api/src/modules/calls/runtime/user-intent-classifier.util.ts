/**
 * High-level conversational intent for voice routing (before tools / LLM).
 * Keeps greetings and small talk from being treated as catalog searches.
 */
export type UserUtteranceIntent =
  | 'store_identity_question'
  | 'store_category_question'
  | 'capability_question'
  | 'general_business_question'
  | 'greeting'
  | 'small_talk'
  | 'product_search'
  | 'product_question'
  | 'payment_question'
  | 'purchase_confirmation'
  | 'email_provided'
  | 'correction'
  | 'unclear'
  | 'unknown';

function norm(text: string): string {
  return text.toLowerCase().trim();
}

function hasProductOrCatalogSignal(t: string): boolean {
  return (
    /\b(do you have|have you got|got any|carry|stock|in stock|isbn|sku|book|books|title|author|edition|copy|looking for|search|find|catalog|check\s+[\w-]+)\b/i.test(
      t,
    ) || /\b\d{10,13}\b/.test(t)
  );
}

/**
 * Classify caller intent for routing. Order of checks matters (e.g. small talk before generic "i want").
 */
export function classifyUserIntent(text: string): UserUtteranceIntent {
  const raw = text.trim();
  const t = norm(raw);
  if (!t) return 'unclear';

  if (
    /\b(what store is this|where am i calling|who are you|what is this store|is this a bookstore)\b/.test(
      t,
    )
  ) {
    return 'store_identity_question';
  }

  if (
    /\b(do you sell|can i get|do you have)\b/.test(t) &&
    /\b(sports|clothes|clothing|electronics|toys|shoes|furniture|appliances)\b/.test(t)
  ) {
    return 'store_category_question';
  }

  if (/\b(what can you do|how can you help|what do you do|how do you help)\b/.test(t)) {
    return 'capability_question';
  }

  if (/\b(what('?s| is) your name|who am i speaking with|who is this)\b/.test(t)) {
    return 'store_identity_question';
  }

  if (/\b(what is your role|what('?s| is) your role|what is your job|what('?s| is) your job)\b/.test(t)) {
    return 'capability_question';
  }

  if (/\b(how does this work|can i order from here|how do i order|how can i order)\b/.test(t)) {
    return 'general_business_question';
  }

  // Thanks / politeness (not a product request)
  if (
    /^(thanks|thank you|thx|ty|appreciate it|much appreciated)\b/i.test(t) ||
    /^thanks?\s+(a lot|so much)\b/i.test(t)
  ) {
    return 'small_talk';
  }

  // Small talk
  if (
    /\bhow\s+(are|r)\s+(you|u|ya)\b/.test(t) ||
    /\bhow('?s| is)\s+(it|everything|things|your day)\b/.test(t) ||
    /\bwhat'?s\s+up\b/.test(t) ||
    /\bhow\s+do\s+you\s+do\b/.test(t) ||
    /\bnice\s+to\s+meet\b/.test(t) ||
    /\b(good\s+)?(nice|lovely)\s+(weather|day)\b/.test(t) ||
    /\bhow\s+('?s| has)\s+(your|the)\s+day\b/.test(t)
  ) {
    return 'small_talk';
  }

  // Pure greetings (short, no catalog signals)
  const words = t.split(/\s+/).filter(Boolean);
  if (
    words.length <= 4 &&
    !hasProductOrCatalogSignal(t) &&
    /^(hi|hello|hey|howdy|yo|greetings|good\s+(morning|afternoon|evening|day))\b/i.test(t)
  ) {
    return 'greeting';
  }

  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(raw)) {
    return 'email_provided';
  }

  if (
    /\b(no|nope|not)\b.*\b(mean|meant|actually)\b|\bi mean\b|\b(instead|rather)\b|\bwrong (book|one|title|item)\b|\bnot that\b|\bdifferent (book|one|title)\b/i.test(
      t,
    )
  ) {
    return 'correction';
  }

  if (
    /\b(payment|pay|checkout|how does payment work|secure payment|payment link|how it works)\b/i.test(
      t,
    )
  ) {
    return 'payment_question';
  }

  if (
    /\b(is this book|does it include|what edition|paperback|hardcover|language|summary|author|publisher)\b/i.test(
      t,
    )
  ) {
    return 'product_question';
  }

  // Purchase confirmation intent without a specific product question
  const orderFlowPhrase =
    /\b(want to buy|wanna buy|would like to buy|like to buy|going to buy|ready to (pay|checkout|order)|place (an |my |the )?order|start (an |my )?order|complete (my |the )?purchase|checkout|pay now|buy something)\b/i.test(
      t,
    );
  const onlyBuyIntent =
    /^i\s+(want|would like|need)\s+to\s+buy[\s!.?]*$/i.test(raw) ||
    /^i\s+want\s+to\s+make\s+a\s+purchase[\s!.?]*$/i.test(raw);

  if ((onlyBuyIntent || orderFlowPhrase) && !hasProductOrCatalogSignal(t)) {
    return 'purchase_confirmation';
  }

  // Product search
  if (
    hasProductOrCatalogSignal(t) &&
    !/\b(what store is this|where am i calling|who are you|what do you sell|what can you do|how can you help|how does this work|can i order from here)\b/.test(
      t,
    )
  ) {
    return 'product_search';
  }

  if (
    /\b(looking for|search(ing)? for|need (a |an |the |some )?|want (a |an |the |some )?|can i get|can you find)\b/i.test(t)
  ) {
    return 'product_search';
  }

  // Longer utterances are often titles or descriptions — treat as search
  if (words.length >= 5 && !/^(yes|no|ok|okay|sure|uh|um)\b/i.test(t)) {
    return 'product_search';
  }

  if (/^(yes|no|ok|okay|sure|uh|um|hmm|maybe)\b/i.test(t)) {
    return 'unclear';
  }

  return 'unclear';
}
