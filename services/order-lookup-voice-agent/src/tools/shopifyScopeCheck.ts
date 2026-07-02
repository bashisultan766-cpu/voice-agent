import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";

export const SHOPIFY_MISSING_PRODUCTS_SCOPE_ERROR = "SHOPIFY TOKEN MISSING read_products SCOPE";

let scopesVerified = false;

function shopOrigin(): string {
  const domain = getConfig().SHOPIFY_SHOP_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}`;
}

function authHeaders(): Record<string, string> {
  return {
    "X-Shopify-Access-Token": getConfig().SHOPIFY_ADMIN_ACCESS_TOKEN,
    "Content-Type": "application/json",
  };
}

interface AccessScopesResponse {
  access_scopes?: Array<{ handle?: string }>;
}

/**
 * Verify Shopify token can read products before any product search.
 * Calls GET /admin/api/{version}/shop.json then confirms read_products scope.
 */
export async function ensureShopifyProductScopes(): Promise<void> {
  if (scopesVerified) return;

  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);

  try {
    const shopRes = await fetch(
      `${shopOrigin()}/admin/api/${cfg.SHOPIFY_API_VERSION}/shop.json`,
      { headers: authHeaders(), signal: controller.signal },
    );

    if (!shopRes.ok) {
      const body = await shopRes.text();
      throw new Error(`shopify_shop_check_failed_${shopRes.status}:${body.slice(0, 120)}`);
    }

    const scopesRes = await fetch(`${shopOrigin()}/admin/oauth/access_scopes.json`, {
      headers: authHeaders(),
      signal: controller.signal,
    });

    if (!scopesRes.ok) {
      const body = await scopesRes.text();
      throw new Error(`shopify_scope_check_failed_${scopesRes.status}:${body.slice(0, 120)}`);
    }

    const scopesBody = (await scopesRes.json()) as AccessScopesResponse;
    const handles = (scopesBody.access_scopes ?? [])
      .map((s) => s.handle?.toLowerCase())
      .filter(Boolean);

    if (!handles.includes("read_products")) {
      throw new Error(SHOPIFY_MISSING_PRODUCTS_SCOPE_ERROR);
    }

    scopesVerified = true;
    logger.info("shopify_product_scopes_verified", { scopes: handles });
  } finally {
    clearTimeout(timer);
  }
}

export function resetShopifyScopeCheck(): void {
  scopesVerified = false;
}
