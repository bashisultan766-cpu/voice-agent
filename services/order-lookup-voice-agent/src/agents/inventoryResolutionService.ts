/**
 * InventoryResolutionService — business owner for the inventory decision that
 * gates cart adds and pre-checkout validation.
 *
 * Responsibilities:
 *   - Fetches live inventory via `ShopifyInventoryService` (the infra client),
 *     applies a freshness policy, and stamps the resolution on
 *     `sessionMemory.inventoryDecisions`.
 *   - Returns a structured decision: allow, reduce, out_of_stock, or unknown.
 *   - Never surfaces raw Shopify shapes — callers see the decision only.
 *
 * Cart + checkout callers consume this service exclusively; they must not
 * re-run stock checks against the query boundary directly.
 */
import type { CallSession } from "../types/order.js";
import { logger } from "../utils/logger.js";
import { ensureSessionMemory, type SessionMemoryState } from "./sessionMemory.js";
import { fetchLiveInventoryByVariantIds } from "../services/shopifyInventoryService.js";

export type InventoryDecision = "allow" | "reduce" | "out_of_stock" | "unknown";

export interface InventoryResolution {
  variantId: string;
  requestedQuantity: number;
  availableQuantity: number | null;
  decision: InventoryDecision;
  checkedAt: number;
  sourceVersion: string;
}

export interface InventoryResolutionRequest {
  variantId: string;
  requestedQuantity: number;
}

export interface InventoryResolutionOptions {
  /** Skip cache and force a live provider call. */
  force?: boolean;
  /** Override freshness window (ms) for tests. */
  freshnessWindowMs?: number;
}

const DEFAULT_FRESHNESS_WINDOW_MS = 60_000;
const SOURCE_VERSION = "shopify_inventory_service_v1";

interface StoredInventoryDecisions {
  entries: Record<string, InventoryResolution>;
}

function ensureDecisions(session: CallSession): StoredInventoryDecisions {
  const memory = ensureSessionMemory(session) as SessionMemoryState & {
    inventoryDecisions?: StoredInventoryDecisions;
  };
  if (!memory.inventoryDecisions) {
    memory.inventoryDecisions = { entries: {} };
  }
  return memory.inventoryDecisions;
}

function classify(
  requestedQuantity: number,
  availableQuantity: number | null,
): InventoryDecision {
  if (availableQuantity == null) return "unknown";
  if (availableQuantity <= 0) return "out_of_stock";
  if (availableQuantity < requestedQuantity) return "reduce";
  return "allow";
}

function isFresh(
  resolution: InventoryResolution | undefined,
  windowMs: number,
  requestedQuantity: number,
): boolean {
  if (!resolution) return false;
  if (Date.now() - resolution.checkedAt > windowMs) return false;
  // If the caller now wants MORE than we last verified, we cannot reuse.
  return requestedQuantity <= resolution.requestedQuantity;
}

/**
 * Resolve inventory for one variant. Returns `unknown` when the live provider
 * is unavailable so callers can fail-closed.
 */
export async function resolveInventory(
  session: CallSession,
  request: InventoryResolutionRequest,
  options: InventoryResolutionOptions = {},
): Promise<InventoryResolution> {
  return (
    await resolveInventoryBatch(session, [request], options)
  )[0]!;
}

/**
 * Batch resolve. Freshness policy is applied per variant so we only re-hit the
 * provider for the entries that need it.
 */
export async function resolveInventoryBatch(
  session: CallSession,
  requests: InventoryResolutionRequest[],
  options: InventoryResolutionOptions = {},
): Promise<InventoryResolution[]> {
  const window = options.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS;
  const decisions = ensureDecisions(session);
  const now = Date.now();
  const results: InventoryResolution[] = [];
  const toFetch: InventoryResolutionRequest[] = [];

  for (const request of requests) {
    const cached = decisions.entries[request.variantId];
    if (!options.force && isFresh(cached, window, request.requestedQuantity)) {
      results.push({
        ...cached!,
        requestedQuantity: request.requestedQuantity,
        decision: classify(request.requestedQuantity, cached!.availableQuantity),
      });
    } else {
      toFetch.push(request);
    }
  }

  if (toFetch.length > 0) {
    const variantIds = toFetch.map((r) => r.variantId);
    let map: Record<string, number> | undefined;
    let unavailable = false;
    try {
      const live = await fetchLiveInventoryByVariantIds(variantIds);
      map = live.map;
      unavailable = live.unavailable;
    } catch (err) {
      logger.warn("inventory_resolution_provider_failed", {
        variants: variantIds.length,
        reason: err instanceof Error ? err.message : String(err),
      });
      unavailable = true;
    }

    for (const request of toFetch) {
      const availableQuantity =
        !unavailable && map && Object.prototype.hasOwnProperty.call(map, request.variantId)
          ? map[request.variantId]!
          : null;
      const resolution: InventoryResolution = {
        variantId: request.variantId,
        requestedQuantity: request.requestedQuantity,
        availableQuantity,
        decision: classify(request.requestedQuantity, availableQuantity),
        checkedAt: now,
        sourceVersion: SOURCE_VERSION,
      };
      decisions.entries[request.variantId] = resolution;
      results.push(resolution);
    }
  }

  return results;
}

/**
 * Read the last known decision for a variant without triggering a fetch.
 * Callers that only need a hint (e.g. optimistic UI) should use this.
 */
export function peekInventoryDecision(
  session: CallSession,
  variantId: string,
): InventoryResolution | undefined {
  const memory = session.sessionMemory as
    | (SessionMemoryState & { inventoryDecisions?: StoredInventoryDecisions })
    | undefined;
  return memory?.inventoryDecisions?.entries[variantId];
}

/** Clear all cached decisions — used when the caller pivots to a new cart. */
export function clearInventoryDecisions(session: CallSession): void {
  const memory = session.sessionMemory as
    | (SessionMemoryState & { inventoryDecisions?: StoredInventoryDecisions })
    | undefined;
  if (memory?.inventoryDecisions) {
    memory.inventoryDecisions = { entries: {} };
  }
}

const LOW_STOCK_THRESHOLD = 3;

export interface CartAddInventoryGuardrail {
  decision: InventoryDecision;
  availableQuantity: number | null;
  temporaryReservation: boolean;
  suggestAlternatives: boolean;
  speech?: string;
  /** Cap the cart line to this quantity when decision is reduce. */
  cappedQuantity?: number;
}

function seedFromHints(
  session: CallSession,
  variantId: string,
  requestedQuantity: number,
  hints: { inventoryQuantity?: number; catalogQuantity?: number },
): InventoryResolution | undefined {
  const qtyHint =
    hints.inventoryQuantity != null && Number.isFinite(Number(hints.inventoryQuantity))
      ? Math.max(0, Math.floor(Number(hints.inventoryQuantity)))
      : hints.catalogQuantity != null && Number.isFinite(Number(hints.catalogQuantity))
        ? Math.max(0, Math.floor(Number(hints.catalogQuantity)))
        : null;
  if (qtyHint == null) return undefined;

  const resolution: InventoryResolution = {
    variantId,
    requestedQuantity,
    availableQuantity: qtyHint,
    decision: classify(requestedQuantity, qtyHint),
    checkedAt: Date.now(),
    sourceVersion: `${SOURCE_VERSION}:hint`,
  };
  ensureDecisions(session).entries[variantId] = resolution;
  return resolution;
}

/**
 * Cache-aside stock guard for cart quantity increases.
 * Peeks sessionMemory.inventoryDecisions; seeds from item/catalog hints when cold;
 * never hits Shopify directly (live fetch is resolveInventory / resolveInventoryBatch).
 */
export function guardCartAddInventory(
  session: CallSession,
  input: {
    variantId: string;
    requestedQuantity: number;
    bookTitle: string;
    inventoryQuantityHint?: number;
    catalogQuantityHint?: number;
  },
): CartAddInventoryGuardrail {
  const variantId = (input.variantId ?? "").trim();
  const requested = Math.max(1, Math.floor(input.requestedQuantity) || 1);
  const bookTitle = (input.bookTitle ?? "that book").trim() || "that book";

  let resolution =
    (variantId ? peekInventoryDecision(session, variantId) : undefined) ??
    (variantId
      ? seedFromHints(session, variantId, requested, {
          inventoryQuantity: input.inventoryQuantityHint,
          catalogQuantity: input.catalogQuantityHint,
        })
      : undefined);

  // No variant / no hint → unknown (do not block add; fail-open for incomplete SKU).
  if (!resolution) {
    return {
      decision: "unknown",
      availableQuantity: null,
      temporaryReservation: false,
      suggestAlternatives: false,
    };
  }

  const available = resolution.availableQuantity;
  const decision = classify(requested, available);

  if (decision === "out_of_stock") {
    return {
      decision,
      availableQuantity: 0,
      temporaryReservation: false,
      suggestAlternatives: true,
      speech:
        `I'm sorry — ${bookTitle} is currently out of stock. ` +
        `I can check if a pre-order is available, or suggest similar titles that ship today.`,
    };
  }

  if (decision === "reduce" && available != null) {
    return {
      decision,
      availableQuantity: available,
      temporaryReservation: true,
      suggestAlternatives: false,
      cappedQuantity: available,
      speech:
        available < LOW_STOCK_THRESHOLD
          ? `Just a heads-up: we only have ${available} ${available === 1 ? "copy" : "copies"} of ${bookTitle} left. ` +
            `I'll place a temporary reservation for ${Math.min(requested, available)} ` +
            `${Math.min(requested, available) === 1 ? "copy" : "copies"} while we finish checkout.`
          : `We only have ${available} ${available === 1 ? "copy" : "copies"} of ${bookTitle} available right now. ` +
            `I'll reserve ${available} for you with a temporary reservation.`,
    };
  }

  if (available != null && available > 0 && available < LOW_STOCK_THRESHOLD) {
    return {
      decision: "allow",
      availableQuantity: available,
      temporaryReservation: true,
      suggestAlternatives: false,
      cappedQuantity: Math.min(requested, available),
      speech:
        `Just a heads-up: we only have ${available} ${available === 1 ? "copy" : "copies"} of ${bookTitle} left. ` +
        `I'll place a temporary reservation while we finish checkout.`,
    };
  }

  return {
    decision: "allow",
    availableQuantity: available,
    temporaryReservation: false,
    suggestAlternatives: false,
  };
}

export const InventoryResolutionService = {
  resolveInventory,
  resolveInventoryBatch,
  peekInventoryDecision,
  clearInventoryDecisions,
  guardCartAddInventory,
} as const;
