/**
 * Sole Shopify Admin GraphQL/REST transport for conversational reads.
 * Conversational modules must not call fetch — import helpers from here or QueryBoundary.
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  isShopifyThrottleError,
  parseShopifyGraphqlErrors,
  ShopifyAuthError,
} from "../platform/shopifyErrors.js";
import { maskShopifyToken } from "../utils/security.js";

function shopifyBaseUrl(): string {
  const cfg = getConfig();
  const domain = cfg.SHOPIFY_SHOP_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}/admin/api/${cfg.SHOPIFY_API_VERSION}`;
}

function summarizeShopifyGraphqlErrors(errors: unknown): {
  errorsJson: string;
  codes: string[];
  messages: string[];
} {
  const list = Array.isArray(errors) ? errors : [];
  const codes: string[] = [];
  const messages: string[] = [];

  for (const entry of list) {
    const err = entry as {
      message?: unknown;
      extensions?: { code?: unknown } | null;
    } | null;
    const message = typeof err?.message === "string" ? err.message : null;
    const code =
      typeof err?.extensions?.code === "string" ? err.extensions.code : null;
    if (message) messages.push(message);
    if (code) codes.push(code);
  }

  let errorsJson = "[]";
  try {
    errorsJson = JSON.stringify(errors ?? [], null, 2);
  } catch {
    errorsJson = String(errors);
  }

  return { errorsJson, codes, messages };
}

export async function shopifyGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const cfg = getConfig();
  const accessToken = cfg.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);

  const started = Date.now();
  try {
    console.log("[shopify_graphql]", query);
    const res = await fetch(`${shopifyBaseUrl()}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let httpBodyText: string | null = null;
      try {
        httpBodyText = await res.text();
      } catch {
        httpBodyText = null;
      }
      let parsedErrors: unknown = null;
      try {
        parsedErrors = httpBodyText ? (JSON.parse(httpBodyText) as { errors?: unknown })?.errors : null;
      } catch {
        parsedErrors = null;
      }
      const summary = summarizeShopifyGraphqlErrors(parsedErrors);
      if (res.status === 401 || res.status === 403) {
        logger.error("SHOPIFY_AUTH_FAILED: Invalid Token or Missing Scopes", {
          httpStatus: res.status,
          token: maskShopifyToken(accessToken),
          shop: cfg.SHOPIFY_SHOP_DOMAIN,
          queryName: query.split("\n")[0]?.trim() ?? null,
          extensionCodes: summary.codes,
          errorMessages: summary.messages,
          shopifyErrors: summary.errorsJson,
          responseBodyPreview: httpBodyText?.slice(0, 2000) ?? null,
        });
        throw new ShopifyAuthError(res.status);
      }
      logger.error("shopify_graphql_http_error", {
        httpStatus: res.status,
        shop: cfg.SHOPIFY_SHOP_DOMAIN,
        queryName: query.split("\n")[0]?.trim() ?? null,
        extensionCodes: summary.codes,
        errorMessages: summary.messages,
        shopifyErrors: summary.errorsJson,
        responseBodyPreview: httpBodyText?.slice(0, 2000) ?? null,
      });
      throw new Error(`shopify_graphql_http_${res.status}`);
    }

    const body = (await res.json()) as { data?: T; errors?: unknown[] };
    if (body.errors?.length) {
      const throttled = parseShopifyGraphqlErrors(body.errors);
      if (throttled) throw throttled;

      const summary = summarizeShopifyGraphqlErrors(body.errors);
      const authDenied = (body.errors as Array<{ message?: string; extensions?: { code?: string } }>).some(
        (e) =>
          /access denied|unauthorized|invalid api key|invalid access token/i.test(
            e.message ?? "",
          ) || e.extensions?.code === "ACCESS_DENIED",
      );

      logger.error(
        authDenied
          ? "SHOPIFY_GRAPHQL_ACCESS_DENIED: field/scope detail"
          : "shopify_graphql_errors",
        {
          token: maskShopifyToken(accessToken),
          shop: cfg.SHOPIFY_SHOP_DOMAIN,
          queryName: query.split("\n")[0]?.trim() ?? null,
          extensionCodes: summary.codes,
          errorMessages: summary.messages,
          shopifyErrors: summary.errorsJson,
        },
      );

      if (authDenied) {
        throw new ShopifyAuthError(403);
      }

      throw new Error(
        `shopify_graphql_error:${summary.messages.join(" | ") || summary.errorsJson.slice(0, 500)}`,
      );
    }

    logger.debug("shopify_live_graphql_ok", {
      elapsedMs: Date.now() - started,
      query: query.split("\n")[0]?.trim(),
    });

    return body.data as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function shopifyRestJson<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const cfg = getConfig();
  const accessToken = cfg.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`${shopifyBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`, {
      method: init?.method ?? "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyAuthError(res.status);
      }
      return { ok: false, status: res.status };
    }
    return { ok: true, data: (await res.json()) as T };
  } finally {
    clearTimeout(timer);
  }
}

export { isShopifyThrottleError };
