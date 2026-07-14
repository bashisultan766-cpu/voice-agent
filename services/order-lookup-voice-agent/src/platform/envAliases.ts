/**
 * Map common deployment aliases onto canonical Shopify env keys.
 * Kept free of getConfig() so config.ts can normalize before parsing.
 */
export function normalizeShopifyEnvAliases(): void {
  if (!process.env.SHOPIFY_SHOP_DOMAIN?.trim()) {
    const alias =
      process.env.SHOPIFY_STORE_DOMAIN?.trim() ??
      process.env.SHOPIFY_SHOP?.trim();
    if (alias) {
      // Accept bare shop name (sureshotbooks) or full host.
      process.env.SHOPIFY_SHOP_DOMAIN = alias.includes(".")
        ? alias
        : `${alias}.myshopify.com`;
    }
  }

  if (!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim()) {
    const alias =
      process.env.SHOPIFY_API_KEY?.trim() ??
      process.env.SHOPIFY_ACCESS_TOKEN?.trim() ??
      process.env.SHOPIFY_ADMIN_API_TOKEN?.trim();
    if (alias) process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = alias;
  }

  // Production deploy aliases → canonical keys.
  if (!process.env.SUPPORT_HUMAN_WEBHOOK?.trim() && process.env.HUMAN_ESCALATION_WEBHOOK?.trim()) {
    process.env.SUPPORT_HUMAN_WEBHOOK = process.env.HUMAN_ESCALATION_WEBHOOK.trim();
  }
  if (!process.env.FACILITY_RESTRICTION_DB?.trim() && process.env.FACILITY_RESTRICTIONS_URL?.trim()) {
    process.env.FACILITY_RESTRICTION_DB = process.env.FACILITY_RESTRICTIONS_URL.trim();
  }
}
