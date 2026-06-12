import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ShopifyClientService } from '../shopify/client';
import { normalizeCallerPhone } from './utils/caller-phone.util';

export type ShopifyCustomerMatch = {
  customerId: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  ordersCount: number;
  lastOrderDate: string | null;
  purchases: Array<{
    title: string;
    quantity: number;
    orderName: string | null;
    purchasedAt: string | null;
  }>;
};

const CUSTOMER_LOOKUP_QUERY = /* GraphQL */ `
  query CallerCustomerLookup($q: String!) {
    customers(first: 5, query: $q) {
      edges {
        node {
          id
          firstName
          lastName
          displayName
          email
          phone
          numberOfOrders
          orders(first: 10, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                name
                createdAt
                lineItems(first: 10) {
                  edges {
                    node {
                      title
                      quantity
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

type CustomerNode = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  numberOfOrders?: string | number | null;
  orders?: {
    edges?: Array<{
      node?: {
        name?: string | null;
        createdAt?: string | null;
        lineItems?: { edges?: Array<{ node?: { title?: string | null; quantity?: number | null } }> };
      };
    }>;
  };
};

/**
 * Live Shopify customer + order history lookup by caller phone.
 * Requires read_customers + read_orders on the store token.
 * Lets the agent recognize customers who ordered BEFORE the voice agent existed —
 * no 3CX API needed.
 */
@Injectable()
export class ShopifyCustomerLookupService {
  private readonly logger = new Logger(ShopifyCustomerLookupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyClient: ShopifyClientService,
    private readonly config: ConfigService,
  ) {}

  async findCustomerByPhone(rawPhone: string): Promise<ShopifyCustomerMatch | null> {
    const { normalized, digits } = normalizeCallerPhone(rawPhone);
    if (!normalized || digits.length < 7) return null;

    let shopify: { domain: string; token: string; apiVersion: string };
    try {
      const ctx = await this.resolveAgentContext();
      shopify = await this.shopifyClient.getAgentShopifyConfig(ctx.tenantId, ctx.agentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        JSON.stringify({
          event: 'shopify_customer_lookup.config_unavailable',
          message: message.slice(0, 200),
        }),
      );
      return null;
    }

    const queries = [`phone:${normalized}`, `phone:*${digits.slice(-10)}`];

    for (const q of queries) {
      try {
        const data = await this.shopifyClient.adminGraphql<{
          customers?: { edges?: Array<{ node?: CustomerNode }> };
        }>(shopify.domain, shopify.token, CUSTOMER_LOOKUP_QUERY, { q }, shopify.apiVersion);

        const nodes = (data.customers?.edges ?? [])
          .map((edge) => edge.node)
          .filter((node): node is CustomerNode => Boolean(node?.id));

        const match =
          nodes.find((node) => phonesShareDigits(node.phone ?? '', digits)) ?? nodes[0] ?? null;

        if (match) {
          const result = this.mapCustomer(match);
          this.logger.log(
            JSON.stringify({
              event: 'shopify_customer_lookup.match',
              hasName: Boolean(result.displayName),
              ordersCount: result.ordersCount,
              purchases: result.purchases.length,
              phoneMasked: `***${digits.slice(-4)}`,
            }),
          );
          return result;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          JSON.stringify({
            event: 'shopify_customer_lookup.query_failed',
            query: q.startsWith('phone:*') ? 'digits' : 'e164',
            message: message.slice(0, 250),
          }),
        );
      }
    }

    return null;
  }

  private mapCustomer(node: CustomerNode): ShopifyCustomerMatch {
    const firstName = node.firstName?.trim() || null;
    const lastName = node.lastName?.trim() || null;
    const displayName =
      node.displayName?.trim() || [firstName, lastName].filter(Boolean).join(' ').trim() || null;

    const purchases: ShopifyCustomerMatch['purchases'] = [];
    let lastOrderDate: string | null = null;

    for (const orderEdge of node.orders?.edges ?? []) {
      const order = orderEdge?.node;
      if (!order) continue;
      const createdAt = order.createdAt ?? null;
      if (createdAt && (!lastOrderDate || createdAt > lastOrderDate)) {
        lastOrderDate = createdAt;
      }
      for (const lineEdge of order.lineItems?.edges ?? []) {
        const line = lineEdge?.node;
        const title = line?.title?.trim();
        if (!title) continue;
        purchases.push({
          title,
          quantity: Math.max(1, Number(line?.quantity ?? 1) || 1),
          orderName: order.name ?? null,
          purchasedAt: createdAt,
        });
      }
    }

    return {
      customerId: node.id,
      displayName,
      firstName,
      lastName,
      email: node.email?.trim() || null,
      ordersCount: Number(node.numberOfOrders ?? 0) || purchases.length,
      lastOrderDate,
      purchases,
    };
  }

  private async resolveAgentContext(): Promise<{ tenantId: string; agentId: string }> {
    const envTenant = this.config.get<string>('VOICE_DEFAULT_TENANT_ID')?.trim();
    const envAgent = this.config.get<string>('VOICE_DEFAULT_AGENT_ID')?.trim();
    if (envTenant && envAgent) {
      return { tenantId: envTenant, agentId: envAgent };
    }

    const agent = await this.prisma.agent.findFirst({
      where: { deletedAt: null, status: { in: [AgentStatus.ACTIVE, AgentStatus.READY] } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, tenantId: true },
    });
    if (!agent) {
      throw new Error('No active agent for Shopify customer lookup.');
    }
    return { tenantId: envTenant ?? agent.tenantId, agentId: envAgent ?? agent.id };
  }
}

function phonesShareDigits(a: string, b: string): boolean {
  const left = (a ?? '').replace(/\D/g, '');
  const right = (b ?? '').replace(/\D/g, '');
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 10 && right.length >= 10) return left.slice(-10) === right.slice(-10);
  return left.endsWith(right) || right.endsWith(left);
}
