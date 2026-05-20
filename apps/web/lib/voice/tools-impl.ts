import type { PrismaClient, StoreSetting } from '@bookstore-voice-agents/voice-db';

export type ToolContext = {
  prisma: PrismaClient;
  storeKey: string;
  settings: StoreSetting;
};

function normalizePhone(input: string): string {
  return input.replace(/\D/g, '').slice(-10);
}

export async function toolGetOrderStatus(
  ctx: ToolContext,
  args: { orderNumber: string; phone: string },
): Promise<Record<string, unknown>> {
  const orderToken = args.orderNumber.replace(/^#/i, '').trim();
  if (!orderToken || !args.phone?.trim()) {
    return {
      ok: false,
      message: 'Missing order number or phone. Ask the caller for both before looking up an order.',
    };
  }

  const shopifyDomain = (ctx.settings.shopifyDomain || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(
    /^https?:\/\//,
    '',
  );
  const accessToken = ctx.settings.shopifyAdminToken || process.env.SHOPIFY_ADMIN_API_TOKEN;

  if (!shopifyDomain || !accessToken) {
    return {
      ok: false,
      configured: false,
      message:
        'Order lookup is not configured. Do not invent order details. Offer a callback or direct the caller to email support.',
    };
  }

  const callerDigits = normalizePhone(args.phone);
  const url = new URL(`https://${shopifyDomain}/admin/api/2024-10/orders.json`);
  url.searchParams.set('status', 'any');
  url.searchParams.set('limit', '15');
  url.searchParams.set('name', orderToken);

  const res = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      message: `Shopify returned ${res.status}. Do not invent order details. Apologize briefly and offer a callback.`,
      detail: text.slice(0, 200),
    };
  }

  const data = (await res.json()) as {
    orders?: Array<{
      id: number;
      name: string;
      financial_status: string;
      fulfillment_status: string | null;
      created_at: string;
      phone?: string | null;
      customer?: { phone?: string | null } | null;
    }>;
  };

  const orders = data.orders ?? [];
  if (!orders.length) {
    return { ok: true, found: false, message: 'No matching order found for that number and phone.' };
  }

  const match = orders.find((o) => {
    const p = normalizePhone((o.phone || o.customer?.phone || '').toString());
    return p && p === callerDigits;
  });

  if (!match) {
    return {
      ok: true,
      found: false,
      message:
        'An order with that number exists but the phone on file does not match. Do not disclose other orders. Ask them to verify details or offer a callback.',
    };
  }

  return {
    ok: true,
    found: true,
    orderName: match.name,
    financialStatus: match.financial_status,
    fulfillmentStatus: match.fulfillment_status ?? 'unfulfilled',
    createdAt: match.created_at,
  };
}

export async function toolBookCallback(
  ctx: ToolContext,
  args: { name: string; phone: string; preferredTime: string },
): Promise<Record<string, unknown>> {
  const row = await ctx.prisma.callbackBooking.create({
    data: {
      storeKey: ctx.storeKey,
      name: args.name.trim(),
      phone: args.phone.trim(),
      preferredTime: args.preferredTime.trim(),
    },
  });
  return { ok: true, id: row.id, message: 'Callback booked.' };
}

export async function toolSearchFaq(
  ctx: ToolContext,
  args: { query: string },
): Promise<Record<string, unknown>> {
  const q = args.query.trim();
  if (!q) return { ok: true, matches: [] };

  const terms = q.split(/\s+/).filter((t) => t.length > 1).slice(0, 6);
  const where =
    terms.length === 0
      ? { storeKey: ctx.storeKey, isActive: true }
      : {
          storeKey: ctx.storeKey,
          isActive: true,
          OR: terms.flatMap((t) => [
            { question: { contains: t, mode: 'insensitive' as const } },
            { answer: { contains: t, mode: 'insensitive' as const } },
          ]),
        };

  const matches = await ctx.prisma.faqItem.findMany({
    where,
    orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    take: 5,
    select: { question: true, answer: true, category: true },
  });

  return { ok: true, matches };
}
