export type MockShopifySearchResult = {
  ok: boolean;
  products: Array<{ title: string; price?: string; inStock?: boolean }>;
  latencyMs: number;
};

let searchDelayMs = 80;
let shouldFail = false;
let shouldTimeout = false;

export function resetMockShopify(): void {
  searchDelayMs = 80;
  shouldFail = false;
  shouldTimeout = false;
}

export function setMockShopifyDelay(ms: number): void {
  searchDelayMs = ms;
}

export function setMockShopifyFail(fail: boolean): void {
  shouldFail = fail;
}

export function setMockShopifyTimeout(timeout: boolean): void {
  shouldTimeout = timeout;
}

export async function mockShopifySearch(_query: string): Promise<MockShopifySearchResult> {
  if (shouldTimeout) {
    await new Promise((r) => setTimeout(r, 3000));
    return { ok: false, products: [], latencyMs: 3000 };
  }
  await new Promise((r) => setTimeout(r, searchDelayMs));
  if (shouldFail) {
    return { ok: false, products: [], latencyMs: searchDelayMs };
  }
  return {
    ok: true,
    products: [{ title: 'Mock Book', price: '$14.99', inStock: true }],
    latencyMs: searchDelayMs,
  };
}
