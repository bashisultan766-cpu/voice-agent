/**
 * Single order-lookup + transactional cart workflow — shared speech, retry signals,
 * status classification, and currentSessionCart projection.
 * Found orders use Concierge Gateway speech only (status + follow-up; no automatic dump).
 * Cart mutations go through applySessionCartQuantity so order + cart sticky state stay reconciled
 * (avoids a double workflow where LLM tools and deterministic cart turns diverge).
 */
import type { OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import {
  ORDER_LOOKUP_MAINTENANCE_SPOKEN,
  ORDER_LOOKUP_RETRY_SPOKEN,
  ORDER_NOT_FOUND_STRICT_SPOKEN,
  SHOPIFY_TIMEOUT_SPOKEN,
} from "../constants/systemMessages.js";
import type { CallSession, ShoppingCartLineItem } from "../types/order.js";
import { orderNumbersMatch } from "../utils/formatter.js";
import { normalizeOrderNumber } from "../utils/inputNormalizer.js";
import {
  type CartActionType,
  type CartItemInput,
  ensureShoppingCart,
  updateCartItemQuantity,
} from "./cartManager.js";
import { groundedOrderSpeech } from "./fulfillmentHandlers.js";
import {
  ORDER_FOUND_PASSIVE_SPEECH,
  buildOrderFoundGatewaySpeech,
  buildStickyOrderStillOpenSpeech,
} from "./orderLookupProtocol.js";
import { hasConfirmedOrderContext } from "./orderContextPolicy.js";

export {
  ORDER_FOUND_PASSIVE_SPEECH,
  buildOrderFoundGatewaySpeech,
  buildStickyOrderStillOpenSpeech,
};

/** Sticky session memory — order already loaded for this call. */
export type CurrentSessionOrder = {
  orderNumber: string;
  customerName?: string;
  fulfillmentStatus?: string;
  financialStatus?: string;
};

/** Transactional cart engine — sku/variant key → quantity. */
export type CurrentSessionCart = Record<string, number>;

/** Verbal intent → engine action (aliases: set→set_exact, minus→remove). */
export type SessionCartActionType = "add" | "set" | "minus" | CartActionType;

export interface SessionCartUpdateResult {
  cart: ShoppingCartLineItem[];
  currentSessionCart: CurrentSessionCart;
  actionType: CartActionType;
  needsRemovalConfirmation?: boolean;
  confirmationSpeech?: string;
  /** True when facility compliance blocked the cart mutation. */
  complianceBlocked?: boolean;
  /** True when facility type/state is required before add. */
  needsFacilityInfo?: boolean;
  message: string;
}

export type FacilityComplianceStatus = "approved" | "restricted" | "facility_unknown";

export interface FacilityComplianceResult {
  status: FacilityComplianceStatus;
  bookTitle: string;
  facilityLabel: string;
  matchedRestriction?: string;
  speech: string;
}

const US_STATE_ALIASES: Record<string, string[]> = {
  al: ["al", "alabama"],
  ak: ["ak", "alaska"],
  az: ["az", "arizona"],
  ar: ["ar", "arkansas"],
  ca: ["ca", "california"],
  co: ["co", "colorado"],
  ct: ["ct", "connecticut"],
  de: ["de", "delaware"],
  fl: ["fl", "florida"],
  ga: ["ga", "georgia"],
  hi: ["hi", "hawaii"],
  id: ["id", "idaho"],
  il: ["il", "illinois"],
  in: ["in", "indiana"],
  ia: ["ia", "iowa"],
  ks: ["ks", "kansas"],
  ky: ["ky", "kentucky"],
  la: ["la", "louisiana"],
  me: ["me", "maine"],
  md: ["md", "maryland"],
  ma: ["ma", "massachusetts"],
  mi: ["mi", "michigan"],
  mn: ["mn", "minnesota"],
  ms: ["ms", "mississippi"],
  mo: ["mo", "missouri"],
  mt: ["mt", "montana"],
  ne: ["ne", "nebraska"],
  nv: ["nv", "nevada"],
  nh: ["nh", "newhampshire", "new hampshire"],
  nj: ["nj", "newjersey", "new jersey"],
  nm: ["nm", "newmexico", "new mexico"],
  ny: ["ny", "newyork", "new york"],
  nc: ["nc", "northcarolina", "north carolina"],
  nd: ["nd", "northdakota", "north dakota"],
  oh: ["oh", "ohio"],
  ok: ["ok", "oklahoma"],
  or: ["or", "oregon"],
  pa: ["pa", "pennsylvania"],
  ri: ["ri", "rhodeisland", "rhode island"],
  sc: ["sc", "southcarolina", "south carolina"],
  sd: ["sd", "southdakota", "south dakota"],
  tn: ["tn", "tennessee"],
  tx: ["tx", "texas"],
  ut: ["ut", "utah"],
  vt: ["vt", "vermont"],
  va: ["va", "virginia"],
  wa: ["wa", "washington"],
  wv: ["wv", "westvirginia", "west virginia"],
  wi: ["wi", "wisconsin"],
  wy: ["wy", "wyoming"],
  dc: ["dc", "districtofcolumbia", "district of columbia", "washington dc"],
};

function normalizeFacilityToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve spoken facility / state into comparable tokens. */
export function normalizeFacilityInput(raw: string | undefined): string[] {
  const text = normalizeFacilityToken(raw ?? "");
  if (!text) return [];
  const tokens = new Set<string>([text, ...text.split(" ").filter((t) => t.length >= 2)]);
  const compact = text.replace(/\s+/g, "");
  if (compact) tokens.add(compact);

  for (const [code, aliases] of Object.entries(US_STATE_ALIASES)) {
    if (aliases.some((a) => text === a || text.includes(a) || compact === a.replace(/\s+/g, ""))) {
      tokens.add(code);
      for (const a of aliases) tokens.add(a);
    }
  }

  if (/\bfederal\b/.test(text)) {
    tokens.add("federal");
    tokens.add("bop");
  }
  if (/\b(state\s+prison|state\s+facility|doc)\b/.test(text)) {
    tokens.add("state");
    tokens.add("state_prison");
  }
  if (/\b(county|jail)\b/.test(text)) {
    tokens.add("county");
    tokens.add("jail");
  }
  return [...tokens];
}

function collectRestrictionKeys(
  tags: string[] | undefined,
  metafields: Array<{ namespace: string; key: string; value: string }> | undefined,
): { states: string[]; facilityTypes: string[]; raw: string[] } {
  const states = new Set<string>();
  const facilityTypes = new Set<string>();
  const raw: string[] = [];

  for (const tag of tags ?? []) {
    const t = tag.trim().toLowerCase();
    if (!t) continue;
    raw.push(t);
    const stateMatch = t.match(/^restricted_state[_:-]?([a-z]{2})$/i);
    if (stateMatch?.[1]) states.add(stateMatch[1].toLowerCase());
    const typeMatch = t.match(/^restricted_facility_type[_:-]?(.+)$/i);
    if (typeMatch?.[1]) facilityTypes.add(normalizeFacilityToken(typeMatch[1]).replace(/\s+/g, "_"));
    if (t === "restricted" || t === "restricted_facility") {
      facilityTypes.add("restricted");
    }
  }

  for (const mf of metafields ?? []) {
    const key = `${mf.namespace}.${mf.key}`.toLowerCase();
    const value = normalizeFacilityToken(mf.value ?? "");
    if (!value) continue;
    raw.push(`${key}:${value}`);
    if (key.includes("restricted_state") || mf.key.toLowerCase().includes("restricted_state")) {
      const code = value.slice(0, 2);
      states.add(code);
      for (const token of normalizeFacilityInput(value)) states.add(token);
    }
    if (
      key.includes("restricted_facility") ||
      mf.key.toLowerCase().includes("restricted_facility_type")
    ) {
      facilityTypes.add(value.replace(/\s+/g, "_"));
      for (const token of normalizeFacilityInput(value)) facilityTypes.add(token.replace(/\s+/g, "_"));
    }
  }

  return { states: [...states], facilityTypes: [...facilityTypes], raw };
}

/**
 * Proactive facility compliance check — cross-references product tags/metafields
 * against the caller's facility type / state before cart mutation.
 */
export function checkFacilityCompliance(input: {
  bookTitle: string;
  facilityType?: string;
  tags?: string[];
  metafields?: Array<{ namespace: string; key: string; value: string }>;
}): FacilityComplianceResult {
  const bookTitle = (input.bookTitle || "that book").trim() || "that book";
  const facilityLabel = (input.facilityType ?? "").trim();
  const restrictions = collectRestrictionKeys(input.tags, input.metafields);
  const hasRestrictions =
    restrictions.states.length > 0 ||
    restrictions.facilityTypes.length > 0 ||
    restrictions.raw.some((r) => r.includes("restricted"));

  if (!facilityLabel) {
    return {
      status: "facility_unknown",
      bookTitle,
      facilityLabel: "",
      speech:
        "I don't have the facility type on file. Could you provide the state or facility type so I can verify book approval for you?",
    };
  }

  if (!hasRestrictions) {
    return {
      status: "approved",
      bookTitle,
      facilityLabel,
      speech: `${bookTitle} has been added to your cart.`,
    };
  }

  const facilityTokens = new Set(normalizeFacilityInput(facilityLabel));
  let matched: string | undefined;

  for (const state of restrictions.states) {
    if (facilityTokens.has(state) || [...facilityTokens].some((t) => t === state || t.includes(state))) {
      matched = `restricted_state_${state}`;
      break;
    }
  }
  if (!matched) {
    for (const type of restrictions.facilityTypes) {
      const typeNorm = type.replace(/\s+/g, "_");
      if (
        typeNorm === "restricted" ||
        [...facilityTokens].some(
          (t) =>
            t === typeNorm ||
            t.replace(/\s+/g, "_") === typeNorm ||
            typeNorm.includes(t.replace(/\s+/g, "_")) ||
            t.replace(/\s+/g, "_").includes(typeNorm),
        )
      ) {
        matched = `restricted_facility_type_${typeNorm}`;
        break;
      }
    }
  }

  if (matched) {
    return {
      status: "restricted",
      bookTitle,
      facilityLabel,
      matchedRestriction: matched,
      speech:
        `I've checked our database, and I'm sorry to inform you that ${bookTitle} is currently flagged as restricted for ${facilityLabel}. ` +
        `To save you the trouble of a rejected delivery, I recommend we look for an alternative. Would you like to see similar, approved titles?`,
    };
  }

  return {
    status: "approved",
    bookTitle,
    facilityLabel,
    speech: `${bookTitle} has been added to your cart.`,
  };
}

export function rememberFacilityType(session: CallSession, facilityType: string | undefined): void {
  const trimmed = (facilityType ?? "").trim();
  if (trimmed) session.facilityType = trimmed;
}

function cartLineKey(line: ShoppingCartLineItem): string {
  return (line.isbn ?? line.variantId ?? line.title).trim() || line.title;
}

/** Rebuild currentSessionCart from shoppingCart lines (single projection). */
export function syncCurrentSessionCart(session: CallSession): CurrentSessionCart {
  const cart = ensureShoppingCart(session);
  const map: CurrentSessionCart = {};
  for (const line of cart) {
    map[cartLineKey(line)] = line.quantity;
  }
  session.currentSessionCart = map;
  return map;
}

export function getCurrentSessionCart(session?: CallSession): CurrentSessionCart {
  if (!session) return {};
  if (session.currentSessionCart) return { ...session.currentSessionCart };
  return syncCurrentSessionCart(session);
}

/** Normalize LLM / speech action_type into cartManager enums. */
export function normalizeSessionCartAction(
  actionRaw: string | undefined,
): CartActionType {
  const raw = String(actionRaw ?? "add").trim().toLowerCase();
  if (raw === "set" || raw === "set_exact" || raw === "exact") return "set_exact";
  if (raw === "minus" || raw === "remove" || raw === "subtract") return "remove";
  return "add";
}

/**
 * Stateful cart engine: add = current+incoming, set = incoming, minus = current-incoming.
 * If minus/set would drop below 1 without confirmRemoval, ask before clearing the line.
 * Facility compliance runs before any quantity increase (add / set above current).
 */
export function applySessionCartQuantity(
  session: CallSession,
  item: CartItemInput,
  quantity: number,
  actionTypeRaw: SessionCartActionType | string,
  options?: { confirmRemoval?: boolean; facilityType?: string },
): SessionCartUpdateResult {
  const actionType = normalizeSessionCartAction(String(actionTypeRaw));
  rememberFacilityType(session, options?.facilityType);

  const cart = ensureShoppingCart(session);
  const variantHint = (item.variant_id ?? item.item_id ?? item.sku ?? "").trim();
  const title = (item.title ?? "").trim().toLowerCase();
  const index = cart.findIndex(
    (line) =>
      (variantHint &&
        (line.variantId === variantHint ||
          line.isbn === variantHint ||
          line.variantId.endsWith(`/${variantHint}`))) ||
      (title && line.title.toLowerCase() === title),
  );
  const currentQty = index >= 0 ? cart[index]!.quantity : 0;
  const incoming = Math.max(0, Math.floor(Number(quantity) || 0));

  let newTotal: number;
  if (actionType === "add") {
    newTotal = currentQty + Math.max(1, incoming || 1);
  } else if (actionType === "remove") {
    newTotal = currentQty - Math.max(1, incoming || 1);
  } else {
    newTotal = incoming;
  }

  const isIncreasing = newTotal > currentQty;
  if (isIncreasing) {
    const bookTitle =
      item.title?.trim() ||
      session.lastCatalogSearch?.title ||
      (index >= 0 ? cart[index]!.title : "that book");
    const compliance = checkFacilityCompliance({
      bookTitle,
      facilityType: session.facilityType,
      tags: session.lastCatalogSearch?.tags,
      metafields: session.lastCatalogSearch?.metafields,
    });
    if (compliance.status === "facility_unknown") {
      return {
        cart: [...cart],
        currentSessionCart: syncCurrentSessionCart(session),
        actionType,
        needsFacilityInfo: true,
        complianceBlocked: true,
        message: compliance.speech,
        confirmationSpeech:
          "Just so I can ensure this is approved for the facility, could you tell me the facility type or state?",
      };
    }
    if (compliance.status === "restricted") {
      return {
        cart: [...cart],
        currentSessionCart: syncCurrentSessionCart(session),
        actionType,
        complianceBlocked: true,
        message: compliance.speech,
      };
    }
  }

  if (newTotal < 1 && currentQty >= 1 && !options?.confirmRemoval) {
    const line = index >= 0 ? cart[index]! : undefined;
    const titleLabel = line?.title || item.title || "that book";
    const variantId = line?.variantId || variantHint;
    if (variantId) {
      session.pendingCartRemoval = {
        variantId,
        title: titleLabel,
        currentQuantity: currentQty,
      };
    }
    const confirmationSpeech =
      `You have ${currentQty} ${currentQty === 1 ? "copy" : "copies"} of ${titleLabel} in your cart. ` +
      `Do you want to remove the item entirely?`;
    return {
      cart: [...cart],
      currentSessionCart: syncCurrentSessionCart(session),
      actionType,
      needsRemovalConfirmation: true,
      confirmationSpeech,
      message: confirmationSpeech,
    };
  }

  session.pendingCartRemoval = undefined;
  const updated =
    newTotal < 1
      ? updateCartItemQuantity(session, item, 0, "set_exact")
      : actionType === "set_exact"
        ? updateCartItemQuantity(session, item, newTotal, "set_exact")
        : updateCartItemQuantity(
            session,
            item,
            Math.max(1, incoming || 1),
            actionType,
          );

  const currentSessionCart = syncCurrentSessionCart(session);
  const addedTitle =
    item.title?.trim() ||
    session.lastCatalogSearch?.title ||
    (index >= 0 ? cart[index]?.title : undefined) ||
    "that book";
  const finalQty =
    updated.find(
      (line) =>
        (variantHint && line.variantId === variantHint) ||
        (title && line.title.toLowerCase() === title),
    )?.quantity ?? newTotal;
  return {
    cart: updated,
    currentSessionCart,
    actionType,
    message: isIncreasing
      ? `I've updated your cart to ${finalQty} ${finalQty === 1 ? "copy" : "copies"} of ${addedTitle}.`
      : `Cart updated with action_type=${actionType}.`,
  };
}

/** Confirm a pending full-line removal after the agent asked. */
export function confirmPendingCartRemoval(
  session: CallSession,
  confirm: boolean,
): SessionCartUpdateResult | null {
  const pending = session.pendingCartRemoval;
  if (!pending) return null;
  if (!confirm) {
    session.pendingCartRemoval = undefined;
    return {
      cart: [...ensureShoppingCart(session)],
      currentSessionCart: syncCurrentSessionCart(session),
      actionType: "remove",
      message: `Okay — keeping ${pending.currentQuantity} ${pending.currentQuantity === 1 ? "copy" : "copies"} of ${pending.title} in your cart.`,
    };
  }
  return applySessionCartQuantity(
    session,
    { variant_id: pending.variantId, title: pending.title },
    pending.currentQuantity,
    "minus",
    { confirmRemoval: true },
  );
}

/** True when this call session already completed a successful order lookup. */
export function isOrderLookupComplete(session?: CallSession): boolean {
  return (
    Boolean(session?.orderLookupComplete) ||
    Boolean(session?.currentSessionOrder?.orderNumber) ||
    hasConfirmedOrderContext(session)
  );
}

export function getCurrentSessionOrderNumber(session?: CallSession): string {
  return String(
    session?.currentSessionOrder?.orderNumber ??
      session?.currentOrderData?.order_number ??
      session?.currentOrder?.orderNumber ??
      session?.lastOrderStatusResult?.orderNumber ??
      "",
  );
}

/**
 * Context lock: after order_lookup_complete, forbid re-calling get_shopify_order_status
 * for the same order — rely on cached JSON. Allow only when the caller names a different order.
 */
export function shouldBlockOrderLookupReinvoke(
  session: CallSession | undefined,
  requestedOrderNumber?: string,
): boolean {
  if (!isOrderLookupComplete(session)) return false;

  const cached = getCurrentSessionOrderNumber(session);
  if (!cached) return true;

  const requested = normalizeOrderNumber(requestedOrderNumber ?? "");
  if (!requested) return true;

  return orderNumbersMatch(cached, requested);
}

/** Persist sticky CurrentSessionOrder from a found Shopify result. */
export function syncCurrentSessionOrder(
  session: CallSession,
  data: {
    orderNumber?: string;
    customerName?: string;
    fulfillmentStatus?: string;
    financialStatus?: string;
  },
): void {
  const orderNumber = String(data.orderNumber ?? "")
    .replace(/^#/, "")
    .trim();
  if (!orderNumber) return;
  session.currentSessionOrder = {
    orderNumber,
    customerName: data.customerName,
    fulfillmentStatus: data.fulfillmentStatus,
    financialStatus: data.financialStatus,
  };
  session.orderLookupComplete = true;
}

export function clearCurrentSessionOrder(session: CallSession): void {
  session.currentSessionOrder = undefined;
  session.orderLookupComplete = false;
}

export function markOrderLookupComplete(session: CallSession): void {
  session.orderLookupComplete = true;
}

export function clearOrderLookupComplete(session: CallSession): void {
  session.orderLookupComplete = false;
  session.currentSessionOrder = undefined;
}

export function isOrderLookupInsistenceUtterance(text: string): boolean {
  return /\b((?:this\s+is\s+the\s+)?correct|right)\s+order|please\s+(?:find|look\s*(?:it\s+)?up|try\s+again|provide)\b/i.test(
    text.trim(),
  );
}

export function isTransientOrderLookupStatus(
  status: OrderStatusResult["status"] | string | undefined,
): boolean {
  return status === "api_error" || status === "system_maintenance" || status === "throttled";
}

/**
 * Only cache durable positive / format failures.
 * Never cache `not_found` — a first Shopify miss must not block the next live retry
 * when the caller insists with the same digits (common after STT noise or a brief miss).
 */
export function isStableOrderLookupStatus(
  status: OrderStatusResult["status"] | string | undefined,
): boolean {
  return status === "found" || status === "invalid_format";
}

/** Deterministic spoken response for any order lookup tool result — one workflow, no LLM paraphrase. */
export function speechForOrderLookupResult(
  result: OrderStatusResult,
  options?: { insistence?: boolean; session?: CallSession },
): string {
  if (
    result.status === "api_error" &&
    /timeout/i.test(String(result.message ?? ""))
  ) {
    return SHOPIFY_TIMEOUT_SPOKEN;
  }
  if (options?.insistence && isTransientOrderLookupStatus(result.status)) {
    return ORDER_LOOKUP_RETRY_SPOKEN;
  }
  if (isTransientOrderLookupStatus(result.status)) {
    return ORDER_LOOKUP_MAINTENANCE_SPOKEN;
  }
  if (result.status === "found") {
    return groundedOrderSpeech(result, options?.session);
  }
  if (result.status === "not_found") {
    return ORDER_NOT_FOUND_STRICT_SPOKEN;
  }
  return groundedOrderSpeech(result, options?.session);
}

export function isRetriableOrderLookupMiss(
  status: OrderStatusResult["status"] | string | undefined,
): boolean {
  return status === "not_found";
}

export function shouldBypassOrderLookupCache(
  userMessage: string,
  phase?: string,
): boolean {
  if (isOrderLookupInsistenceUtterance(userMessage)) return true;
  if (phase === "awaiting_order_number") return true;
  return /\b(try\s+again|one\s+more\s+time|digit\s+by\s+digit|check\s+(?:the\s+)?system|search\s+again)\b/i.test(
    userMessage.trim(),
  );
}
