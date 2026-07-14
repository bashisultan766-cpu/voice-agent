import { searchByISBN, searchByTitle } from "../infra/shopifyQueryBoundary.js";

export interface ProductSearchView {
  title: string;
  price: string;
  isbn?: string;
  variantId: string;
  available?: boolean;
}

function toView(result: Awaited<ReturnType<typeof searchByTitle>>): ProductSearchView | null {
  if (result.status !== "found" || !result.variantId || !result.bookName) return null;
  return {
    title: result.bookName,
    price: result.price ?? "",
    isbn: result.isbn,
    variantId: result.variantId,
    available: result.inStock,
  };
}

export async function searchProductByTitle(title: string, callSid: string): Promise<ProductSearchView | null> {
  return toView(await searchByTitle(title, callSid));
}

export async function searchProductByIsbn(isbn: string, callSid: string): Promise<ProductSearchView | null> {
  return toView(await searchByISBN(isbn, callSid));
}
