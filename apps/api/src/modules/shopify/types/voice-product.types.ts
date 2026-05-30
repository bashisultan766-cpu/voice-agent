/** Lean product payload for ElevenLabs / Twilio voice agents. */
export type VoiceCatalogProduct = {
  productId: string;
  variantId: string;
  title: string;
  price: string | null;
  inventory: number;
  image: string | null;
  sku: string | null;
  inStock: boolean;
};

export type ShopifySearchResult = {
  products: VoiceCatalogProduct[];
  shopifyLatencyMs: number;
  queriesTried: string[];
};
