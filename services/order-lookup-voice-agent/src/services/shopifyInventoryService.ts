/**
 * Real-time inventory refresh — domain helper over ShopifyQueryBoundary DTOs.
 * Consumes the logistics sidecar via `LogisticsPolicyClient` when configured;
 * fails closed on any error so callers never oversell.
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import type { LiveInventoryMap } from "../agents/logisticsIntelligence.js";
import { fetchInventoryView } from "../infra/shopifyQueryBoundary.js";
import { fetchLogisticsInventory } from "../infra/logisticsPolicyClient.js";

function isTestRuntime(): boolean {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

/**
 * Fetch live inventoryQuantity for Shopify ProductVariant GIDs.
 * On failure returns `{ map: undefined, unavailable: true }` so callers fail-closed.
 */
export async function fetchLiveInventoryByVariantIds(
  variantIds: string[],
): Promise<{ map?: LiveInventoryMap; unavailable: boolean }> {
  const ids = [...new Set(variantIds.map((id) => id.trim()).filter(Boolean))].filter(
    (id) => id.startsWith("gid://shopify/ProductVariant/"),
  );
  if (!ids.length) return { unavailable: false };

  if (isTestRuntime()) return { unavailable: false };

  try {
    const cfg = getConfig();
    if (cfg.SAFE_MODE) {
      logger.warn("live_inventory_skipped_safe_mode", { count: ids.length });
      return { unavailable: true };
    }

    // Prefer the logistics sidecar (LogisticsPolicyClient) when configured; it
    // reflects live warehouse counts that are more accurate than raw Admin API.
    const sidecar = cfg.LOGISTICS_INTELLIGENCE_URL?.trim()
      ? await fetchLogisticsInventory(ids)
      : undefined;
    if (sidecar) {
      const sidecarMap: LiveInventoryMap = {};
      for (const [variantId, quantity] of Object.entries(sidecar)) {
        if (Number.isFinite(quantity)) {
          sidecarMap[variantId] = Math.max(0, Math.floor(Number(quantity)));
        }
      }
      logger.info("live_inventory_refreshed", {
        requested: ids.length,
        resolved: Object.keys(sidecarMap).length,
        source: "logistics_policy_client",
      });
      return { map: sidecarMap, unavailable: false };
    }

    const views = await fetchInventoryView(ids);
    if (views.some((view) => view.unavailable)) {
      return { unavailable: true };
    }
    const map: LiveInventoryMap = {};
    for (const view of views) {
      if (view.available == null) continue;
      map[view.variantId] = view.available;
    }

    logger.info("live_inventory_refreshed", {
      requested: ids.length,
      resolved: Object.keys(map).length,
      source: "shopify_query_boundary",
    });
    return { map, unavailable: false };
  } catch (err) {
    logger.warn("live_inventory_refresh_failed", {
      reason: err instanceof Error ? err.message : String(err),
      count: ids.length,
    });
    return { unavailable: true };
  }
}

/** Resolve variant IDs from cart selectors / full cart for a live refresh. */
export function collectVariantIdsForInventory(
  lines: Array<{ variantId?: string; variant_id?: string }>,
): string[] {
  return lines
    .map((l) => (l.variantId ?? l.variant_id ?? "").trim())
    .filter((id) => id.startsWith("gid://shopify/ProductVariant/"));
}

/** Capability registry alias — maps shopify_inventory_access to this service. */
export const ShopifyInventoryClient = {
  fetchLiveInventoryByVariantIds,
  collectVariantIdsForInventory,
};
