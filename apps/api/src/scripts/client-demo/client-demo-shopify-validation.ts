import type { INestApplicationContext } from '@nestjs/common';
import {
  executeCommerceTool,
  readToolData,
} from './client-demo-commerce.util';
import type { ClientDemoProductValidation } from './client-demo.types';
import { isClientDemoStaging } from './client-demo-safety.util';

function inventoryLabel(data: Record<string, unknown>): {
  status: string;
  inStock: boolean;
} {
  const available = data.availableForSale ?? data.inStock ?? data.available;
  const qty = data.inventoryQuantity ?? data.quantityAvailable;
  if (available === true || (typeof qty === 'number' && qty > 0)) {
    return { status: 'in_stock', inStock: true };
  }
  if (available === false || qty === 0) {
    return { status: 'out_of_stock', inStock: false };
  }
  return { status: 'unknown', inStock: false };
}

export async function validateShopifyProducts(
  app: INestApplicationContext,
  tenantId: string,
  agentId: string,
  opts: {
    productQuery: string;
    isbnQuery?: string;
    customerEmail: string;
    createCheckout?: boolean;
  },
): Promise<ClientDemoProductValidation> {
  const errors: string[] = [];
  const query = opts.productQuery.trim();
  const isbnQuery = opts.isbnQuery?.trim();
  let productFound = false;
  let productId: string | undefined;
  let title: string | undefined;
  let price: string | undefined;
  let inventoryStatus: string | undefined;
  let inStock = false;
  let checkoutLinkCreated = false;
  let checkoutUrl: string | undefined;
  let checkoutLinkId: string | undefined;
  let searchLatencyMs: number | undefined;
  let checkoutLatencyMs: number | undefined;
  let callSessionId: string | undefined;
  let variantId: string | undefined;

  const runSearch = async (q: string, label: string): Promise<boolean> => {
    const started = Date.now();
    const search = await executeCommerceTool(app, tenantId, agentId, {
      callSessionId,
      toolName: 'searchProducts',
      args: { query: q, limit: 5 },
    });
    searchLatencyMs = Date.now() - started;
    callSessionId = search.callSessionId;

    if (!search.result.ok) {
      errors.push(`${label}_search_failed:${search.result.error?.message ?? 'unknown'}`);
      return false;
    }

    const data = readToolData(search.result);
    const results = Array.isArray(data.results)
      ? (data.results as Array<Record<string, unknown>>)
      : [];
    const first = results[0];
    if (!first) {
      errors.push(`${label}_no_products`);
      return false;
    }

    productFound = true;
    productId = typeof first.id === 'string' ? first.id : undefined;
    title = typeof first.title === 'string' ? first.title : undefined;
    price =
      typeof first.price === 'string'
        ? first.price
        : typeof first.priceRange === 'string'
          ? first.priceRange
          : undefined;

    const variants = Array.isArray(first.variants)
      ? (first.variants as Array<Record<string, unknown>>)
      : [];
    variantId =
      typeof variants[0]?.id === 'string' ? (variants[0].id as string) : productId;
    const inv = inventoryLabel(first);
    inventoryStatus = inv.status;
    inStock = inv.inStock;
    return true;
  };

  const titleOk = await runSearch(query, 'title');
  if (!titleOk && isbnQuery) {
    await runSearch(isbnQuery, 'isbn');
  } else if (!titleOk) {
    errors.push('product_not_found_for_query');
  }

  if (productFound && productId) {
    const details = await executeCommerceTool(app, tenantId, agentId, {
      callSessionId,
      toolName: 'getProductDetails',
      args: { productId, variantId },
    });
    if (!details.result.ok) {
      errors.push(`getProductDetails_failed:${details.result.error?.message ?? 'unknown'}`);
    } else {
      const d = readToolData(details.result);
      if (typeof d.title === 'string') title = d.title;
      if (typeof d.price === 'string') price = d.price;
      const inv = inventoryLabel(d);
      inventoryStatus = inv.status;
      inStock = inv.inStock;
    }
  }

  if (opts.createCheckout !== false && productFound && variantId) {
    const checkoutStarted = Date.now();
    const checkout = await executeCommerceTool(app, tenantId, agentId, {
      callSessionId,
      toolName: 'createCheckoutLink',
      args: {
        email: opts.customerEmail,
        items: [{ variantId, quantity: 1 }],
        forceNewCheckout: true,
      },
    });
    checkoutLatencyMs = Date.now() - checkoutStarted;

    if (!checkout.result.ok) {
      errors.push(`checkout_failed:${checkout.result.error?.message ?? 'unknown'}`);
    } else {
      const c = readToolData(checkout.result);
      checkoutUrl =
        typeof c.checkoutUrl === 'string'
          ? c.checkoutUrl
          : typeof c.url === 'string'
            ? c.url
            : undefined;
      checkoutLinkId =
        typeof c.checkoutLinkId === 'string' ? c.checkoutLinkId : undefined;
      checkoutLinkCreated = Boolean(checkoutUrl?.startsWith('https://'));

      if (isClientDemoStaging() && checkoutUrl && !checkoutUrl.includes('myshopify.com')) {
        // Storefront permalinks may use custom domain — still valid if HTTPS
      }
      if (!checkoutLinkCreated) {
        errors.push('checkout_url_missing_or_not_https');
      }
    }
  }

  const pass =
    productFound &&
    Boolean(title) &&
    Boolean(price || inventoryStatus) &&
    (opts.createCheckout === false || checkoutLinkCreated) &&
    errors.length === 0;

  return {
    pass,
    query,
    isbnQuery,
    productFound,
    productId,
    title,
    price,
    inventoryStatus,
    inStock,
    checkoutLinkCreated,
    checkoutUrl,
    checkoutLinkId,
    searchLatencyMs,
    checkoutLatencyMs,
    errors,
  };
}
