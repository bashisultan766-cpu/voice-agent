export interface ProductVariant {
  id: string;
  sku?: string;
  barcode?: string;
  price: string;
  inStock: boolean;
  inventoryQuantity: number;
}

export interface StructuredProduct {
  id: string;
  title: string;
  handle: string;
  productType: string;
  vendor: string;
  author?: string;
  tags: string[];
  variants: ProductVariant[];
  isbns?: string[];
  descriptionSnippet?: string;
}

export interface ProductSearchResult {
  status: "found" | "not_found" | "api_error";
  products: StructuredProduct[];
  query: string;
  message?: string;
}

export interface InventoryStatus {
  productId: string;
  title: string;
  inStock: boolean;
  totalQuantity: number;
  variantCount: number;
}
