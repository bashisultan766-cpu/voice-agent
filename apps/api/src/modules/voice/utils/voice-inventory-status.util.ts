export type InventoryStatus =
  | 'in_stock'
  | 'out_of_stock'
  | 'backorder'
  | 'discontinued'
  | 'unknown';

export type CatalogMatchType = 'exact' | 'fuzzy' | 'not_found';

/**
 * Never mark in_stock unless inventory confirms quantity > 0.
 * If inventory is unknown, return unknown.
 */
export function resolveInventoryStatus(args: {
  inventory?: number | null;
  availableForSale?: boolean | null;
  overrideStatus?: InventoryStatus | null;
  isBackorder?: boolean;
}): InventoryStatus {
  if (args.overrideStatus) return args.overrideStatus;
  if (args.isBackorder) return 'backorder';
  if (args.inventory == null || Number.isNaN(args.inventory)) return 'unknown';
  if (args.inventory > 0) return 'in_stock';
  if (args.availableForSale === false) return 'discontinued';
  return 'out_of_stock';
}

export function inventoryConfirmedInStock(status: InventoryStatus): boolean {
  return status === 'in_stock';
}
