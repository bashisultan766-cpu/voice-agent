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
      process.env.SHOPIFY_ACCESS_TOKEN?.trim() ??
      process.env.SHOPIFY_ADMIN_API_TOKEN?.trim();
    if (alias) process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = alias;
  }
}
