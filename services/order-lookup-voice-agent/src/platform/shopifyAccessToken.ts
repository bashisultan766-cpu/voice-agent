/**
 * Shopify Admin API auth — Client Credentials Grant with in-memory token cache.
 * Falls back to SHOPIFY_ADMIN_ACCESS_TOKEN when client credentials are not configured.
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { maskShopifyToken } from "../utils/security.js";

const TOKEN_REFRESH_SKEW_MS = 60_000;

interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
}

let cached: CachedAccessToken | null = null;
let inflight: Promise<string> | null = null;

function shopHost(): string {
  return getConfig()
    .SHOPIFY_SHOP_DOMAIN.replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .trim()
    .toLowerCase();
}

function clientCredentialsConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.SHOPIFY_CLIENT_ID?.trim() && cfg.SHOPIFY_CLIENT_SECRET?.trim());
}

function staticAdminToken(): string | null {
  const token = getConfig().SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
  return token || null;
}

function tokenStillValid(entry: CachedAccessToken): boolean {
  return Date.now() < entry.expiresAtMs - TOKEN_REFRESH_SKEW_MS;
}

async function fetchClientCredentialsToken(): Promise<CachedAccessToken> {
  const cfg = getConfig();
  const clientId = cfg.SHOPIFY_CLIENT_ID!.trim();
  const clientSecret = cfg.SHOPIFY_CLIENT_SECRET!.trim();
  const url = `https://${shopHost()}/admin/oauth/access_token`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: controller.signal,
    });

    const rawText = await res.text();
    let body: {
      access_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
      errors?: unknown;
    } = {};
    try {
      body = rawText ? (JSON.parse(rawText) as typeof body) : {};
    } catch {
      body = {};
    }

    if (!res.ok || !body.access_token) {
      logger.error("shopify_client_credentials_failed", {
        httpStatus: res.status,
        shop: cfg.SHOPIFY_SHOP_DOMAIN,
        error: body.error ?? null,
        errorDescription: body.error_description ?? null,
        userErrors: body.errors ?? null,
      });
      throw new Error(
        `shopify_client_credentials_http_${res.status}${
          body.error ? `:${body.error}` : ""
        }${body.error_description ? `:${body.error_description}` : ""}`,
      );
    }

    const expiresInSec =
      typeof body.expires_in === "number" && body.expires_in > 0
        ? body.expires_in
        : 86_399;

    logger.info("shopify_client_credentials_ok", {
      shop: cfg.SHOPIFY_SHOP_DOMAIN,
      token: maskShopifyToken(body.access_token),
      expiresInSec,
      scope: body.scope ?? null,
    });

    return {
      accessToken: body.access_token,
      expiresAtMs: Date.now() + expiresInSec * 1000,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns a valid Admin API access token for X-Shopify-Access-Token headers.
 * Uses Client Credentials Grant when SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 * are set; otherwise uses the static SHOPIFY_ADMIN_ACCESS_TOKEN.
 */
export async function getShopifyAdminAccessToken(): Promise<string> {
  if (clientCredentialsConfigured()) {
    if (cached && tokenStillValid(cached)) {
      return cached.accessToken;
    }

    if (!inflight) {
      inflight = fetchClientCredentialsToken()
        .then((entry) => {
          cached = entry;
          return entry.accessToken;
        })
        .finally(() => {
          inflight = null;
        });
    }

    return inflight;
  }

  const staticToken = staticAdminToken();
  if (!staticToken) {
    throw new Error(
      "Shopify auth misconfigured: set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET, or SHOPIFY_ADMIN_ACCESS_TOKEN",
    );
  }
  return staticToken;
}

/** @internal Test helper — clears cached OAuth token between cases. */
export function resetShopifyAccessTokenCacheForTests(): void {
  cached = null;
  inflight = null;
}
