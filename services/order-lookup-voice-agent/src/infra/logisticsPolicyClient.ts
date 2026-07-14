/**
 * Logistics sidecar HTTP client — sole owner of any request to
 * LOGISTICS_INTELLIGENCE_URL. ShopifyQueryBoundary must NOT reach for this
 * endpoint directly; inventory / eligibility decisions consume this client via
 * FacilityPolicyEngine or the inventory business owner.
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";

export interface LogisticsInventoryResponse {
  inventory?: Record<string, number>;
  liveInventory?: Record<string, number>;
}

/**
 * POST `{ variantIds }` to `${LOGISTICS_INTELLIGENCE_URL}/inventory`.
 * Returns the numeric inventory map for the requested variant GIDs, or
 * `undefined` when the sidecar is unavailable / not configured.
 */
export async function fetchLogisticsInventory(
  variantIds: string[],
): Promise<Record<string, number> | undefined> {
  const cfg = getConfig();
  const base = cfg.LOGISTICS_INTELLIGENCE_URL?.trim();
  if (!base) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);
  try {
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/$/, "") + "/inventory";
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantIds }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn("logistics_policy_client_non_2xx", {
        status: res.status,
      });
      return undefined;
    }
    const body = (await res.json()) as LogisticsInventoryResponse;
    return body.inventory ?? body.liveInventory;
  } catch (err) {
    logger.warn("logistics_policy_client_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export const LogisticsPolicyClient = {
  fetchLogisticsInventory,
} as const;
