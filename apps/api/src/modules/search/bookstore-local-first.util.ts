/** Normalized confidence (0–1) above which Shopify live search is skipped. */
export const LOCAL_SEARCH_SKIP_SHOPIFY_MIN_NORMALIZED = 0.75;

/** Relevance score floor equivalent to {@link LOCAL_SEARCH_SKIP_SHOPIFY_MIN_NORMALIZED}. */
export const LOCAL_SEARCH_SKIP_SHOPIFY_MIN_SCORE = Math.round(
  1000 * LOCAL_SEARCH_SKIP_SHOPIFY_MIN_NORMALIZED,
);
