/**
 * Startup environment validation and Shopify Admin API connectivity checks.
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { maskShopifyToken } from "../utils/security.js";
import { ShopifyAuthError } from "./shopifyErrors.js";

const SHOP_DOMAIN_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)?myshopify\.com$/;

const ADMIN_TOKEN_RE = /^(shpat_|shpca_|shpss_)[A-Za-z0-9]+$/;

/** Map common deployment aliases onto canonical config env keys. */
export function normalizeShopifyEnvAliases(): void {
  if (!process.env.SHOPIFY_SHOP_DOMAIN?.trim()) {
    const alias =
      process.env.SHOPIFY_STORE_DOMAIN?.trim() ??
      process.env.SHOPIFY_SHOP?.trim();
    if (alias) process.env.SHOPIFY_SHOP_DOMAIN = alias;
  }

  if (!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim()) {
    const alias =
      process.env.SHOPIFY_ACCESS_TOKEN?.trim() ??
      process.env.SHOPIFY_ADMIN_API_TOKEN?.trim();
    if (alias) process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = alias;
  }
}

function normalizeShopDomain(raw: string): string {
  return raw.replace(/^https?:\/\//, "").replace(/\/$/, "").trim().toLowerCase();
}

/** Validate Shopify credentials exist and match expected formats. */
export function validateShopifyEnvFormat(): void {
  normalizeShopifyEnvAliases();

  const domain = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();

  if (!domain) {
    throw new Error(
      "SHOPIFY_SHOP_DOMAIN is required (alias: SHOPIFY_STORE_DOMAIN)",
    );
  }

  const host = normalizeShopDomain(domain);
  if (!SHOP_DOMAIN_RE.test(host)) {
    throw new Error(
      `SHOPIFY_SHOP_DOMAIN must be a valid Shopify host (*.myshopify.com), got: ${host}`,
    );
  }

  if (!token) {
    throw new Error(
      "SHOPIFY_ADMIN_ACCESS_TOKEN is required (alias: SHOPIFY_ACCESS_TOKEN)",
    );
  }

  if (!ADMIN_TOKEN_RE.test(token)) {
    throw new Error(
      "SHOPIFY_ADMIN_ACCESS_TOKEN must be a Shopify Admin API token (shpat_...)",
    );
  }
}

function shopifyGraphqlUrl(): string {
  const cfg = getConfig();
  const domain = cfg.SHOPIFY_SHOP_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}/admin/api/${cfg.SHOPIFY_API_VERSION}/graphql.json`;
}

const SHOP_PING_QUERY = `query StartupShopPing { shop { name } }`;

/**
 * Lightweight Admin GraphQL ping — verifies token and shop reachability.
 * @throws ShopifyAuthError on 401/403
 */
export async function pingShopifyAdminApi(): Promise<string> {
  validateShopifyEnvFormat();
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);

  try {
    const res = await fetch(shopifyGraphqlUrl(), {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": cfg.SHOPIFY_ADMIN_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: SHOP_PING_QUERY }),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      logger.error("SHOPIFY_AUTH_FAILED: Invalid Token or Missing Scopes", {
        httpStatus: res.status,
        token: maskShopifyToken(cfg.SHOPIFY_ADMIN_ACCESS_TOKEN),
        shop: cfg.SHOPIFY_SHOP_DOMAIN,
      });
      throw new ShopifyAuthError(res.status);
    }

    if (!res.ok) {
      throw new Error(`shopify_startup_ping_http_${res.status}`);
    }

    const body = (await res.json()) as {
      data?: { shop?: { name?: string } };
      errors?: Array<{ message?: string; extensions?: { code?: string } }>;
    };

    const authDenied = body.errors?.some(
      (e) =>
        /access denied|unauthorized|invalid api key|invalid access token/i.test(
          e.message ?? "",
        ) || e.extensions?.code === "ACCESS_DENIED",
    );
    if (authDenied) {
      logger.error("SHOPIFY_AUTH_FAILED: Invalid Token or Missing Scopes", {
        httpStatus: res.status,
        token: maskShopifyToken(cfg.SHOPIFY_ADMIN_ACCESS_TOKEN),
        shop: cfg.SHOPIFY_SHOP_DOMAIN,
      });
      throw new ShopifyAuthError(403);
    }

    const shopName = body.data?.shop?.name?.trim();
    if (!shopName) {
      throw new Error("shopify_startup_ping_empty_shop");
    }

    logger.info("shopify_startup_ping_ok", {
      shop: shopName,
      token: maskShopifyToken(cfg.SHOPIFY_ADMIN_ACCESS_TOKEN),
    });

    return shopName;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fatal startup guard — refuse to serve calls with broken Shopify credentials.
 */
export async function validateEnvironmentOnStartup(): Promise<void> {
  validateShopifyEnvFormat();
  await pingShopifyAdminApi();
}
