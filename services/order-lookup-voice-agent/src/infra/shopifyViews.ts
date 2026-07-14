/** Narrow DTOs returned by the conversational Shopify query boundary. */
export interface InventoryView {
  variantId: string;
  available: number | null;
  unavailable?: boolean;
}

export interface OrderTimelineView {
  events: Array<{ summary: string; at?: string }>;
}

export interface ProductSearchView {
  title: string;
  variantId: string;
  price?: string;
  isbn?: string;
  available: boolean;
}
