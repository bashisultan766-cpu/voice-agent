import type { InventoryStatus } from '../utils/voice-inventory-status.util';

/** Test fixture and catalog overrides — inventory source of truth when Shopify data is stale. */
export const VOICE_CATALOG_INVENTORY_OVERRIDES: Array<{
  match: RegExp;
  status: InventoryStatus;
  reason?: string;
}> = [
  {
    match: /\bred\s+river\s+vengeance\b/i,
    status: 'out_of_stock',
    reason: 'Confirmed out of stock per SureShot Books inventory policy.',
  },
];

export function findCatalogInventoryOverride(title: string): {
  status: InventoryStatus;
  reason?: string;
} | null {
  const normalized = title.trim();
  if (!normalized) return null;
  for (const entry of VOICE_CATALOG_INVENTORY_OVERRIDES) {
    if (entry.match.test(normalized)) {
      return { status: entry.status, reason: entry.reason };
    }
  }
  return null;
}
