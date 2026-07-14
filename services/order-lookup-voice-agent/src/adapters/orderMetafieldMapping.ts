/**
 * Order metafield + timeline attachment mapping — pure helpers for Shopify fidelity.
 * No network I/O. Used by orderDataParser / adapters after GraphQL hydration.
 */

export interface OrderMetafieldBundle {
  productName: string | null;
  endDate: string | null;
  magazineStartDate: string | null;
}

export interface TimelineAttachment {
  fileName: string;
  timestamp: string | null;
}

export interface OrderMetafieldNode {
  namespace?: string | null;
  key?: string | null;
  value?: string | null;
}

/** Keys we always request via metafields(identifiers:). */
export const ORDER_METAFIELD_IDENTIFIERS = [
  { namespace: "custom", key: "productname" },
  { namespace: "custom", key: "enddate" },
  { namespace: "custom", key: "magazinestartdate" },
  { namespace: "global", key: "productname" },
  { namespace: "global", key: "enddate" },
  { namespace: "global", key: "magazinestartdate" },
] as const;

/** GraphQL selection for identifier-based order metafields (not a Connection). */
export const ORDER_METAFIELDS_IDENTIFIERS_SELECTION = `
  metafields(identifiers: [
    {namespace: "custom", key: "productname"},
    {namespace: "custom", key: "enddate"},
    {namespace: "custom", key: "magazinestartdate"},
    {namespace: "global", key: "productname"},
    {namespace: "global", key: "enddate"},
    {namespace: "global", key: "magazinestartdate"}
  ]) {
    namespace
    key
    value
  }
`.trim();

const FILE_IN_MESSAGE_RE =
  /\b([A-Za-z0-9][\w.\-]*\.(?:pdf|jpe?g|png|gif|webp|docx?|xlsx?|csv|txt))\b/gi;

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[_\s-]/g, "");
}

/**
 * Flatten Shopify metafield payloads — supports Connection edges and
 * identifiers[] list shapes.
 */
export function flattenMetafieldNodes(
  metafields:
    | Array<OrderMetafieldNode | null | undefined>
    | { edges?: Array<{ node?: OrderMetafieldNode | null } | null> | null }
    | null
    | undefined,
): Array<{ namespace: string; key: string; value: string }> {
  const out: Array<{ namespace: string; key: string; value: string }> = [];
  if (!metafields) return out;

  const push = (node: OrderMetafieldNode | null | undefined): void => {
    if (!node) return;
    const namespace = String(node.namespace ?? "").trim();
    const key = String(node.key ?? "").trim();
    const value = String(node.value ?? "").trim();
    if (!key) return;
    out.push({ namespace: namespace || "custom", key, value });
  };

  if (Array.isArray(metafields)) {
    for (const node of metafields) push(node);
    return out;
  }

  for (const edge of metafields.edges ?? []) {
    push(edge?.node ?? undefined);
  }
  return out;
}

/** Compile productname / enddate / magazinestartdate into a stable TTS bundle. */
export function compileOrderMetafieldBundle(
  flat: Array<{ namespace: string; key: string; value: string }>,
): OrderMetafieldBundle {
  const byKey = new Map<string, string>();
  for (const mf of flat) {
    const nk = normalizeKey(mf.key);
    if (!mf.value) continue;
    // Prefer custom namespace when both custom + global exist.
    if (!byKey.has(nk) || mf.namespace.toLowerCase() === "custom") {
      byKey.set(nk, mf.value);
    }
  }
  return {
    productName: byKey.get("productname") ?? null,
    endDate: byKey.get("enddate") ?? null,
    magazineStartDate: byKey.get("magazinestartdate") ?? null,
  };
}

/** Extract file attachments referenced in timeline event messages. */
export function extractTimelineAttachments(
  events: Array<{ message?: string | null; createdAt?: string | null }>,
): TimelineAttachment[] {
  const seen = new Set<string>();
  const out: TimelineAttachment[] = [];
  for (const event of events) {
    const message = (event.message ?? "").trim();
    if (!message) continue;
    const re = new RegExp(FILE_IN_MESSAGE_RE.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = re.exec(message)) !== null) {
      const fileName = match[1]?.trim();
      if (!fileName) continue;
      const dedupe = fileName.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({
        fileName,
        timestamp: event.createdAt?.trim() ? event.createdAt.trim() : null,
      });
    }
  }
  return out;
}

/** Prefer gateway names array, else single gateway string. */
export function resolvePaymentMethod(
  paymentGatewayNames: string[] | null | undefined,
  paymentGateway: string | null | undefined,
): string | null {
  const fromNames = (paymentGatewayNames ?? [])
    .map((n) => String(n).trim())
    .filter(Boolean);
  if (fromNames.length) return fromNames.join(", ");
  const single = (paymentGateway ?? "").trim();
  return single || null;
}

export const OrderMetafieldMapping = {
  identifiers: ORDER_METAFIELD_IDENTIFIERS,
  flatten: flattenMetafieldNodes,
  compileBundle: compileOrderMetafieldBundle,
  extractAttachments: extractTimelineAttachments,
  resolvePaymentMethod,
} as const;
