import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { EncryptionService } from '../../../common/encryption.service';
import { ShopifyGraphqlError, ShopifyRestError, isShopifyRetryableError } from './shopify-errors';
import type { ShopifyGraphqlErrorItem } from './shopify-errors';

const DEFAULT_GRAPHQL_ATTEMPTS = Number(process.env.SHOPIFY_GRAPHQL_MAX_ATTEMPTS) || 4;
const DEFAULT_GRAPHQL_BASE_DELAY_MS = Number(process.env.SHOPIFY_GRAPHQL_RETRY_BASE_MS) || 400;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

@Injectable()
export class ShopifyClientService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  private normalizeDomain(rawUrl: string): string {
    return rawUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase();
  }

  async getAgentShopifyConfig(
    tenantId: string,
    agentId: string,
  ): Promise<{ domain: string; token: string; shopifyConnectionId: string | null }> {
    const agent = await this.prisma.agent.findFirstOrThrow({
      where: { id: agentId, tenantId, deletedAt: null },
      select: { shopifyStoreUrl: true, secretsEnc: true, storeId: true },
    });
    if (!agent.shopifyStoreUrl) throw new Error('Shopify store URL is not configured for this agent.');
    if (!this.encryption.isAvailable()) throw new Error('Encrypted Shopify credentials are unavailable.');

    let token: string | null = null;
    let agentToken: string | null = null;
    if (agent.secretsEnc) {
      const decrypted = this.encryption.decryptFromStorage(agent.secretsEnc);
      if (decrypted) {
        try {
          const parsed = JSON.parse(decrypted) as { shopifyAdminToken?: string };
          agentToken = parsed.shopifyAdminToken?.trim() || null;
        } catch {
          agentToken = null;
        }
      }
    }

    const normalizedDomain = this.normalizeDomain(agent.shopifyStoreUrl);
    const connection = agent.storeId
      ? await this.prisma.shopifyConnection.findFirst({
          where: { tenantId, storeId: agent.storeId },
          select: { id: true, accessTokenEnc: true, shopDomain: true },
        })
      : await this.prisma.shopifyConnection.findFirst({
          where: { tenantId, shopDomain: normalizedDomain },
          select: { id: true, accessTokenEnc: true, shopDomain: true },
        });

    // Prefer store/integration connection token first, then fall back to agent-level secret.
    if (connection?.accessTokenEnc) {
      const decTok = this.encryption.decryptFromStorage(connection.accessTokenEnc);
      if (decTok?.trim()) token = decTok.trim();
    }
    if (!token?.trim() && agentToken?.trim()) token = agentToken.trim();

    if (!token?.trim()) throw new Error('Shopify Admin token is missing for this agent.');
    const domain =
      normalizedDomain ||
      (connection?.shopDomain ? this.normalizeDomain(`https://${connection.shopDomain}`) : '');
    if (!domain) throw new Error('Shopify store domain could not be resolved for this agent.');

    return {
      domain,
      token: token.trim(),
      shopifyConnectionId: connection?.id ?? null,
    };
  }

  private parseGraphqlPayload(body: unknown, httpStatus: number): { data?: unknown; errors?: ShopifyGraphqlErrorItem[] } {
    if (!body || typeof body !== 'object') {
      throw new ShopifyGraphqlError(
        `Shopify Admin GraphQL returned a non-JSON body (HTTP ${httpStatus}).`,
        [{ message: 'Invalid JSON response' }],
        httpStatus,
      );
    }
    const b = body as { data?: unknown; errors?: unknown };
    const normalizedErrors: ShopifyGraphqlErrorItem[] = Array.isArray(b.errors)
      ? b.errors
          .map((row) => {
            if (row && typeof row === 'object') {
              const r = row as { message?: unknown; extensions?: unknown; locations?: unknown };
              return {
                message: typeof r.message === 'string' ? r.message : JSON.stringify(row).slice(0, 300),
                extensions: r.extensions && typeof r.extensions === 'object' ? (r.extensions as Record<string, unknown>) : undefined,
                locations: r.locations,
              } satisfies ShopifyGraphqlErrorItem;
            }
            return { message: String(row) } satisfies ShopifyGraphqlErrorItem;
          })
      : typeof b.errors === 'string'
        ? [{ message: b.errors }]
        : [];
    return { data: b.data, errors: normalizedErrors };
  }

  private async executeGraphqlOnce<T>(
    domain: string,
    token: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await response.json().catch(() => null)) as unknown;
    const { data, errors } = this.parseGraphqlPayload(json, response.status);

    if (!response.ok) {
      const msg =
        errors?.[0]?.message ||
        (typeof json === 'object' && json !== null && 'errors' in json
          ? JSON.stringify((json as { errors: unknown }).errors).slice(0, 400)
          : `HTTP ${response.status}`);
      throw new ShopifyGraphqlError(
        `Shopify Admin GraphQL HTTP ${response.status}: ${msg}`,
        errors?.length ? errors : [{ message: msg }],
        response.status,
      );
    }

    if (errors?.length) {
      throw new ShopifyGraphqlError(
        errors.map((e) => e.message).join('; ') || 'GraphQL errors',
        errors,
        response.status,
      );
    }

    if (data === undefined || data === null) {
      throw new ShopifyGraphqlError(
        'Shopify Admin API returned empty data.',
        errors?.length ? errors : [{ message: 'empty data' }],
        response.status,
      );
    }
    return data as T;
  }

  /**
   * Admin GraphQL with retries on throttling / transient HTTP failures.
   */
  async adminGraphql<T>(
    domain: string,
    token: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < DEFAULT_GRAPHQL_ATTEMPTS; attempt++) {
      try {
        return await this.executeGraphqlOnce<T>(domain, token, query, variables);
      } catch (err) {
        lastErr = err;
        const retryable = isShopifyRetryableError(err);
        if (!retryable || attempt === DEFAULT_GRAPHQL_ATTEMPTS - 1) throw err;
        const jitter = Math.floor(Math.random() * 120);
        await sleep(DEFAULT_GRAPHQL_BASE_DELAY_MS * 2 ** attempt + jitter);
      }
    }
    throw lastErr;
  }

  async adminRest<T>(
    domain: string,
    token: string,
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < DEFAULT_GRAPHQL_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`https://${domain}/admin/api/2024-10/${path.replace(/^\//, '')}`, {
          ...init,
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
            ...(init?.headers ?? {}),
          },
        });
        const text = await response.text();
        let payload: unknown;
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          payload = { raw: text.slice(0, 500) };
        }
        const body = payload as T & { errors?: unknown; error?: unknown };

        if (!response.ok) {
          const message =
            (typeof body?.errors === 'string' && body.errors) ||
            (Array.isArray(body?.errors) ? JSON.stringify(body.errors).slice(0, 300) : null) ||
            (typeof body?.error === 'string' && body.error) ||
            `Shopify REST API failed (${response.status}).`;
          throw new ShopifyRestError(message, response.status, text.slice(0, 400));
        }
        if (typeof body === 'object' && body !== null && 'errors' in body && body.errors) {
          throw new ShopifyRestError(
            `Shopify REST API returned errors: ${JSON.stringify(body.errors).slice(0, 400)}`,
            422,
            text.slice(0, 400),
          );
        }
        return body;
      } catch (err) {
        lastErr = err;
        const retryable = isShopifyRetryableError(err);
        if (!retryable || attempt === DEFAULT_GRAPHQL_ATTEMPTS - 1) throw err;
        const jitter = Math.floor(Math.random() * 120);
        await sleep(DEFAULT_GRAPHQL_BASE_DELAY_MS * 2 ** attempt + jitter);
      }
    }
    throw lastErr;
  }
}
