import { Injectable, Logger } from '@nestjs/common';
import { ShopifyClientService } from '../../integrations/shopify/client';
import { VoiceAgentContextService } from './voice-agent-context.service';
import { shopifyOrderNameSearchTokens } from '../utils/normalize-voice-order-number.util';
import type { VoiceOrderDetailDto } from '../dto/get-order.dto';

const EXTENDED_ORDER_LOOKUP_QUERY = `
  query VoiceExtendedOrderLookup($query: String!) {
    orders(first: 1, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          legacyResourceId
          name
          createdAt
          cancelledAt
          cancelReason
          closed
          displayFinancialStatus
          displayFulfillmentStatus
          note
          email
          phone
          customer {
            displayName
            email
            phone
          }
          shippingAddress {
            name
            address1
            address2
            city
            provinceCode
            zip
            countryCodeV2
          }
          currentSubtotalPriceSet {
            shopMoney { amount currencyCode }
          }
          totalShippingPriceSet {
            shopMoney { amount currencyCode }
          }
          currentTotalPriceSet {
            shopMoney { amount currencyCode }
          }
          shippingLine {
            title
            carrierIdentifier
            code
          }
          lineItems(first: 25) {
            edges {
              node {
                title
                quantity
                sku
                variantTitle
                unfulfilledQuantity
                fulfillableQuantity
                requiresShipping
                product {
                  tags
                }
              }
            }
          }
          fulfillments {
            id
            status
            displayStatus
            createdAt
            updatedAt
            estimatedDeliveryAt
            inTransitAt
            deliveredAt
            trackingInfo {
              company
              number
              url
            }
          }
          refunds {
            id
            createdAt
            note
            totalRefundedSet {
              shopMoney { amount currencyCode }
            }
          }
          transactions(first: 10) {
            kind
            status
            accountNumber
            paymentDetails {
              ... on CardPaymentDetails {
                number
                company
                paymentMethodName
              }
            }
          }
        }
      }
    }
  }
`;

export type ExtendedOrderLineItem = {
  title: string;
  quantity: number;
  sku: string | null;
  variantTitle: string | null;
  unfulfilledQuantity: number;
  fulfillableQuantity: number;
  productTags: string[];
};

export type ExtendedOrderSnapshot = VoiceOrderDetailDto & {
  subtotalWithoutShipping: string | null;
  shippingCost: string | null;
  shippingMethodTitle: string | null;
  shippingCarrier: string | null;
  orderStatus: string;
  refundStatus: string | null;
  extendedLineItems: ExtendedOrderLineItem[];
  isShipped: boolean;
  isCancelled: boolean;
  isRefunded: boolean;
  note: string | null;
};

type GraphqlOrderNode = {
  id?: string;
  legacyResourceId?: string;
  name?: string;
  createdAt?: string;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  closed?: boolean;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  note?: string | null;
  email?: string | null;
  phone?: string | null;
  customer?: {
    displayName?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  shippingAddress?: {
    name?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    provinceCode?: string | null;
    zip?: string | null;
    countryCodeV2?: string | null;
  } | null;
  currentSubtotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } | null } | null;
  totalShippingPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } | null } | null;
  currentTotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } | null } | null;
  shippingLine?: {
    title?: string | null;
    carrierIdentifier?: string | null;
    code?: string | null;
  } | null;
  lineItems?: {
    edges?: Array<{
      node?: {
        title?: string;
        quantity?: number;
        sku?: string | null;
        variantTitle?: string | null;
        unfulfilledQuantity?: number;
        fulfillableQuantity?: number;
        requiresShipping?: boolean;
        product?: { tags?: string[] } | null;
      };
    }>;
  } | null;
  fulfillments?: Array<{
    status?: string | null;
    displayStatus?: string | null;
    createdAt?: string | null;
    estimatedDeliveryAt?: string | null;
    inTransitAt?: string | null;
    deliveredAt?: string | null;
    trackingInfo?: Array<{
      company?: string | null;
      number?: string | null;
      url?: string | null;
    }> | null;
  }> | null;
  refunds?: Array<{
    createdAt?: string;
    note?: string | null;
    totalRefundedSet?: { shopMoney?: { amount?: string; currencyCode?: string } | null } | null;
  }> | null;
  transactions?: Array<{
    kind?: string | null;
    status?: string | null;
    accountNumber?: string | null;
    paymentDetails?: {
      number?: string | null;
      company?: string | null;
      paymentMethodName?: string | null;
    } | null;
  }> | null;
};

function extractCardLast4(masked: string | null | undefined): string | null {
  const digits = (masked ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function resolvePaymentCard(node: GraphqlOrderNode): { last4: string | null; brand: string | null } {
  const transactions = node.transactions ?? [];
  const ranked = [
    ...transactions.filter(
      (t) => t.status === 'SUCCESS' && (t.kind === 'SALE' || t.kind === 'CAPTURE'),
    ),
    ...transactions.filter((t) => t.status === 'SUCCESS'),
    ...transactions,
  ];
  for (const tx of ranked) {
    const last4 =
      extractCardLast4(tx.paymentDetails?.number) ?? extractCardLast4(tx.accountNumber);
    if (last4) {
      return {
        last4,
        brand: tx.paymentDetails?.company ?? tx.paymentDetails?.paymentMethodName ?? null,
      };
    }
  }
  return { last4: null, brand: null };
}

@Injectable()
export class VoiceOrderLookupService {
  private readonly logger = new Logger(VoiceOrderLookupService.name);

  constructor(
    private readonly shopify: ShopifyClientService,
    private readonly agentContext: VoiceAgentContextService,
  ) {}

  async lookupOrder(args: {
    orderNumber: string;
    tenantId?: string;
    agentId?: string;
  }): Promise<ExtendedOrderSnapshot | null> {
    const orderNumber = args.orderNumber.trim();
    if (!orderNumber) return null;

    const { tenantId, agentId } = await this.agentContext.resolveAgentContext(
      args.tenantId,
      args.agentId,
    );
    const shopifyConfig = await this.shopify.getAgentShopifyConfig(tenantId, agentId);
    const searchTokens = shopifyOrderNameSearchTokens(orderNumber);

    for (const token of searchTokens) {
      const data = await this.shopify.adminGraphql<{
        orders?: { edges?: Array<{ node?: GraphqlOrderNode }> };
      }>(
        shopifyConfig.domain,
        shopifyConfig.token,
        EXTENDED_ORDER_LOOKUP_QUERY,
        { query: `name:${token}` },
        shopifyConfig.apiVersion,
      );
      const node = data.orders?.edges?.[0]?.node ?? null;
      if (node?.name) return this.mapExtendedOrder(node);
    }

    this.logger.log(
      JSON.stringify({
        event: 'voice.order_lookup.not_found',
        orderNumber: orderNumber.slice(0, 32),
      }),
    );
    return null;
  }

  private mapExtendedOrder(node: GraphqlOrderNode): ExtendedOrderSnapshot {
    const money = node.currentTotalPriceSet?.shopMoney;
    const subtotal = node.currentSubtotalPriceSet?.shopMoney;
    const shipping = node.totalShippingPriceSet?.shopMoney;
    const paymentCard = resolvePaymentCard(node);
    const shippingAddr = node.shippingAddress;

    const extendedLineItems: ExtendedOrderLineItem[] =
      node.lineItems?.edges
        ?.map((edge) => edge.node)
        .filter((line): line is NonNullable<typeof line> => Boolean(line?.title))
        .map((line) => ({
          title: line.title ?? 'Item',
          quantity: Math.max(1, Number(line.quantity ?? 1)),
          sku: line.sku ?? null,
          variantTitle: line.variantTitle ?? null,
          unfulfilledQuantity: Math.max(0, Number(line.unfulfilledQuantity ?? 0)),
          fulfillableQuantity: Math.max(0, Number(line.fulfillableQuantity ?? 0)),
          productTags: line.product?.tags ?? [],
        })) ?? [];

    const lineItems = extendedLineItems.map((line) => ({
      title: line.title,
      quantity: line.quantity,
      sku: line.sku,
      variantTitle: line.variantTitle,
    }));

    const fulfillments =
      node.fulfillments?.map((f) => ({
        status: f.status ?? null,
        displayStatus: f.displayStatus ?? null,
        estimatedDeliveryAt: f.estimatedDeliveryAt ?? null,
        deliveredAt: f.deliveredAt ?? null,
        inTransitAt: f.inTransitAt ?? null,
        tracking:
          f.trackingInfo?.map((t) => ({
            company: t.company ?? null,
            number: t.number ?? null,
            url: t.url ?? null,
          })) ?? [],
      })) ?? [];

    const refunds =
      node.refunds?.map((r) => ({
        createdAt: r.createdAt ?? new Date(0).toISOString(),
        amount: r.totalRefundedSet?.shopMoney?.amount ?? null,
        currency: r.totalRefundedSet?.shopMoney?.currencyCode ?? null,
        note: r.note ?? null,
      })) ?? [];

    const financialStatus = node.displayFinancialStatus ?? null;
    const fulfillmentStatus = node.displayFulfillmentStatus ?? null;
    const isShipped =
      (fulfillments.length > 0 &&
        fulfillments.some((f) => f.status === 'SUCCESS' || f.displayStatus?.toLowerCase().includes('fulfilled'))) ||
      fulfillmentStatus?.toUpperCase() === 'FULFILLED' ||
      fulfillmentStatus?.toUpperCase() === 'PARTIALLY_FULFILLED';
    const isCancelled = Boolean(node.cancelledAt);
    const isRefunded =
      financialStatus?.toLowerCase().includes('refund') ||
      refunds.length > 0 ||
      financialStatus?.toUpperCase() === 'REFUNDED';

    return {
      id: node.legacyResourceId ?? node.id ?? '',
      orderNumber: node.name ?? '',
      createdAt: node.createdAt ?? '',
      financialStatus,
      fulfillmentStatus,
      cancelledAt: node.cancelledAt ?? null,
      cancelReason: node.cancelReason ?? null,
      totalPrice: money?.amount ?? null,
      currency: money?.currencyCode ?? null,
      customerName: node.customer?.displayName ?? null,
      customerEmail: node.customer?.email ?? node.email ?? null,
      customerPhone: node.customer?.phone ?? node.phone ?? null,
      shippingAddress: shippingAddr
        ? {
            name: shippingAddr.name ?? null,
            address1: shippingAddr.address1 ?? null,
            address2: shippingAddr.address2 ?? null,
            city: shippingAddr.city ?? null,
            provinceCode: shippingAddr.provinceCode ?? null,
            zip: shippingAddr.zip ?? null,
            countryCode: shippingAddr.countryCodeV2 ?? null,
          }
        : null,
      lineItems,
      fulfillments,
      refunds,
      paymentCardLast4: paymentCard.last4,
      paymentCardBrand: paymentCard.brand,
      subtotalWithoutShipping: subtotal?.amount ?? null,
      shippingCost: shipping?.amount ?? null,
      shippingMethodTitle: node.shippingLine?.title ?? null,
      shippingCarrier:
        node.shippingLine?.carrierIdentifier ?? node.shippingLine?.code ?? null,
      orderStatus: isCancelled ? 'cancelled' : isShipped ? 'shipped' : 'open',
      refundStatus: isRefunded ? financialStatus ?? 'refunded' : null,
      extendedLineItems,
      isShipped,
      isCancelled,
      isRefunded,
      note: node.note ?? null,
    };
  }
}
