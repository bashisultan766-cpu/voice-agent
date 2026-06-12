import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ShopifyClientService } from '../integrations/shopify/client';
import type {
  GetOrderResponseDto,
  VoiceOrderDetailDto,
  VoiceOrderFulfillmentDto,
  VoiceOrderLineItemDto,
  VoiceOrderRefundDto,
} from './dto/get-order.dto';
import { buildVoiceOrderSummary } from './utils/build-voice-order-summary.util';
import { shopifyOrderNameSearchTokens } from './utils/normalize-voice-order-number.util';

const ORDER_LOOKUP_QUERY = `
  query VoiceOrderLookup($query: String!) {
    orders(first: 1, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          legacyResourceId
          name
          createdAt
          processedAt
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
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 25) {
            edges {
              node {
                title
                quantity
                sku
                variantTitle
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
              shopMoney {
                amount
                currencyCode
              }
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

type GraphqlOrderNode = {
  id?: string;
  legacyResourceId?: string;
  name?: string;
  createdAt?: string;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
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
  currentTotalPriceSet?: {
    shopMoney?: { amount?: string; currencyCode?: string } | null;
  } | null;
  lineItems?: {
    edges?: Array<{
      node?: {
        title?: string;
        quantity?: number;
        sku?: string | null;
        variantTitle?: string | null;
      };
    }>;
  } | null;
  fulfillments?: Array<{
    status?: string | null;
    displayStatus?: string | null;
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
    totalRefundedSet?: {
      shopMoney?: { amount?: string; currencyCode?: string } | null;
    } | null;
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

/** Last 4 digits from a masked card number like "•••• •••• •••• 4242". */
function extractCardLast4(masked: string | null | undefined): string | null {
  const digits = (masked ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function resolvePaymentCard(node: GraphqlOrderNode): {
  last4: string | null;
  brand: string | null;
} {
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
export class VoiceOrderService {
  private readonly logger = new Logger(VoiceOrderService.name);

  constructor(
    private readonly shopify: ShopifyClientService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getOrder(args: {
    orderNumber: string;
    tenantId?: string;
    agentId?: string;
  }): Promise<GetOrderResponseDto> {
    const started = Date.now();
    const orderNumber = args.orderNumber.trim();
    if (!orderNumber) {
      throw new BadRequestException('order_number is required.');
    }

    const { tenantId, agentId } = await this.resolveAgentContext(args.tenantId, args.agentId);

    this.logger.log(
      JSON.stringify({
        event: 'voice.order.lookup_started',
        tenantId,
        agentId,
        orderNumber: orderNumber.slice(0, 32),
      }),
    );

    try {
      const shopifyConfig = await this.shopify.getAgentShopifyConfig(tenantId, agentId);
      const searchTokens = shopifyOrderNameSearchTokens(orderNumber);
      let node: GraphqlOrderNode | null = null;

      for (const token of searchTokens) {
        const data = await this.shopify.adminGraphql<{
          orders?: { edges?: Array<{ node?: GraphqlOrderNode }> };
        }>(
          shopifyConfig.domain,
          shopifyConfig.token,
          ORDER_LOOKUP_QUERY,
          { query: `name:${token}` },
          shopifyConfig.apiVersion,
        );
        node = data.orders?.edges?.[0]?.node ?? null;
        if (node?.name) break;
      }

      const latencyMs = Date.now() - started;

      if (!node?.name) {
        const notFoundSummary = `No order found with number ${orderNumber}. Ask the caller to verify the order number on their confirmation email.`;
        this.logger.log(
          JSON.stringify({
            event: 'voice.order.not_found',
            tenantId,
            agentId,
            orderNumber: orderNumber.slice(0, 32),
            latencyMs,
          }),
        );
        return {
          success: true,
          found: false,
          voiceSummary: notFoundSummary,
          latencyMs,
        };
      }

      const order = this.mapOrderNode(node);
      const voiceSummary = buildVoiceOrderSummary(order);

      this.logger.log(
        JSON.stringify({
          event: 'voice.order.found',
          tenantId,
          agentId,
          orderNumber: order.orderNumber,
          financialStatus: order.financialStatus,
          fulfillmentStatus: order.fulfillmentStatus,
          lineItemCount: order.lineItems.length,
          fulfillmentCount: order.fulfillments.length,
          latencyMs,
        }),
      );

      return {
        success: true,
        found: true,
        order,
        voiceSummary,
        latencyMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        JSON.stringify({
          event: 'voice.order.lookup_failed',
          message: message.slice(0, 400),
          latencyMs: Date.now() - started,
        }),
      );
      return {
        success: false,
        found: false,
        error: message,
        voiceSummary:
          'I could not look up that order right now. Apologize briefly and offer to try again or connect the caller with support.',
        latencyMs: Date.now() - started,
      };
    }
  }

  private mapOrderNode(node: GraphqlOrderNode): VoiceOrderDetailDto {
    const money = node.currentTotalPriceSet?.shopMoney;
    const lineItems: VoiceOrderLineItemDto[] =
      node.lineItems?.edges
        ?.map((edge) => edge.node)
        .filter((line): line is NonNullable<typeof line> => Boolean(line?.title))
        .map((line) => ({
          title: line.title ?? 'Item',
          quantity: Math.max(1, Number(line.quantity ?? 1)),
          sku: line.sku ?? null,
          variantTitle: line.variantTitle ?? null,
        })) ?? [];

    const fulfillments: VoiceOrderFulfillmentDto[] =
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

    const refunds: VoiceOrderRefundDto[] =
      node.refunds?.map((r) => ({
        createdAt: r.createdAt ?? new Date(0).toISOString(),
        amount: r.totalRefundedSet?.shopMoney?.amount ?? null,
        currency: r.totalRefundedSet?.shopMoney?.currencyCode ?? null,
        note: r.note ?? null,
      })) ?? [];

    const shipping = node.shippingAddress;
    const paymentCard = resolvePaymentCard(node);

    return {
      id: node.legacyResourceId ?? node.id ?? '',
      orderNumber: node.name ?? '',
      createdAt: node.createdAt ?? '',
      financialStatus: node.displayFinancialStatus ?? null,
      fulfillmentStatus: node.displayFulfillmentStatus ?? null,
      cancelledAt: node.cancelledAt ?? null,
      cancelReason: node.cancelReason ?? null,
      totalPrice: money?.amount ?? null,
      currency: money?.currencyCode ?? null,
      customerName: node.customer?.displayName ?? null,
      customerEmail: node.customer?.email ?? node.email ?? null,
      customerPhone: node.customer?.phone ?? node.phone ?? null,
      shippingAddress: shipping
        ? {
            name: shipping.name ?? null,
            address1: shipping.address1 ?? null,
            address2: shipping.address2 ?? null,
            city: shipping.city ?? null,
            provinceCode: shipping.provinceCode ?? null,
            zip: shipping.zip ?? null,
            countryCode: shipping.countryCodeV2 ?? null,
          }
        : null,
      lineItems,
      fulfillments,
      refunds,
      paymentCardLast4: paymentCard.last4,
      paymentCardBrand: paymentCard.brand,
    };
  }

  private async resolveAgentContext(
    tenantId?: string,
    agentId?: string,
  ): Promise<{ tenantId: string; agentId: string }> {
    const envTenant = this.config.get<string>('VOICE_DEFAULT_TENANT_ID')?.trim();
    const envAgent = this.config.get<string>('VOICE_DEFAULT_AGENT_ID')?.trim();

    const resolvedTenant = tenantId?.trim() || envTenant;
    const resolvedAgent = agentId?.trim() || envAgent;

    if (resolvedTenant && resolvedAgent) {
      return { tenantId: resolvedTenant, agentId: resolvedAgent };
    }

    const agent = await this.prisma.agent.findFirst({
      where: { deletedAt: null, status: { in: [AgentStatus.ACTIVE, AgentStatus.READY] } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, tenantId: true },
    });
    if (!agent) {
      throw new BadRequestException(
        'No agent context. Provide tenantId/agentId or set VOICE_DEFAULT_TENANT_ID and VOICE_DEFAULT_AGENT_ID.',
      );
    }
    return { tenantId: resolvedTenant ?? agent.tenantId, agentId: resolvedAgent ?? agent.id };
  }
}
