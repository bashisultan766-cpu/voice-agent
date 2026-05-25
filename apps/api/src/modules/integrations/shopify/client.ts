import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { EncryptionService } from '../../../common/encryption.service';
import {
  logCredentialResolution,
  resolveShopifyConfig,
  type AgentSecretsSlice,
} from '../../../common/credential-resolver.util';
import { ShopifyGraphqlError, ShopifyRestError, isShopifyRetryableError } from './shopify-errors';
import type { ShopifyGraphqlErrorItem } from './shopify-errors';

const DEFAULT_GRAPHQL_ATTEMPTS = Number(process.env.SHOPIFY_GRAPHQL_MAX_ATTEMPTS) || 4;
const DEFAULT_GRAPHQL_BASE_DELAY_MS = Number(process.env.SHOPIFY_GRAPHQL_RETRY_BASE_MS) || 400;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

@Injectable()
export class ShopifyClientService {
  private readonly logger = new Logger(ShopifyClientService.name);

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
  ): Promise<{ domain: string; token: string; shopifyConnectionId: string | null; apiVersion: string; source: string }> {
    const agent = await this.prisma.agent.findFirstOrThrow({
      where: { id: agentId, tenantId, deletedAt: null },
      select: {
        shopifyStoreUrl: true,
        secretsEnc: true,
        storeId: true,
        agentConfig: { select: { useWorkspaceShopify: true, shopifyApiVersion: true } },
      },
    });
    if (!this.encryption.isAvailable()) {
      throw new Error('Encrypted Shopify credentials are unavailable.');
    }

    let secrets: AgentSecretsSlice = {};
    if (agent.secretsEnc) {
      const decrypted = this.encryption.decryptFromStorage(agent.secretsEnc);
      if (decrypted) {
        try {
          secrets = JSON.parse(decrypted) as AgentSecretsSlice;
        } catch {
          secrets = {};
        }
      }
    }

    const integration = await this.prisma.tenantIntegration.findUnique({
      where: { tenantId },
      select: { shopifyShopDomain: true, shopifyAdminTokenEnc: true },
    });
    const workspace =
      integration && this.encryption.isAvailable()
        ? {
            shopifyStoreUrl: integration.shopifyShopDomain?.trim()
              ? `https://${integration.shopifyShopDomain.trim()}`
              : undefined,
            shopifyAdminToken: integration.shopifyAdminTokenEnc
              ? (this.encryption.decryptFromStorage(integration.shopifyAdminTokenEnc) ?? undefined)
              : undefined,
          }
        : null;

    const resolved = resolveShopifyConfig({
      agent: {
        shopifyStoreUrl: agent.shopifyStoreUrl,
        secrets,
        useWorkspaceShopify: agent.agentConfig?.useWorkspaceShopify === true,
        shopifyApiVersion: agent.agentConfig?.shopifyApiVersion,
      },
      workspace,
      env: {
        shopifyStoreUrl: process.env.SHOPIFY_SHOP_DOMAIN,
        shopifyAdminToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
      },
    });

    if (!resolved) {
      throw new Error('Shopify credentials missing for this agent.');
    }

    logCredentialResolution(this.logger, 'shopify', resolved.source, agentId);

    const normalizedDomain = this.normalizeDomain(resolved.shopifyStoreUrl);
    const connection = agent.storeId
      ? await this.prisma.shopifyConnection.findFirst({
          where: { tenantId, storeId: agent.storeId },
          select: { id: true, shopDomain: true },
        })
      : await this.prisma.shopifyConnection.findFirst({
          where: { tenantId, shopDomain: normalizedDomain },
          select: { id: true, shopDomain: true },
        });

    const domain =
      normalizedDomain ||
      (connection?.shopDomain ? this.normalizeDomain(`https://${connection.shopDomain}`) : '');
    if (!domain) throw new Error('Shopify store domain could not be resolved for this agent.');

    return {
      domain,
      token: resolved.shopifyAdminToken,
      shopifyConnectionId: connection?.id ?? null,
      apiVersion: resolved.shopifyApiVersion,
      source: resolved.source,
    };
  }

  private parseGraphqlPayload(
    body: unknown,
    httpStatus: number,
  ): { data: unknown; errors: ShopifyGraphqlErrorItem[] } {
    if (!body || typeof body !== 'object') {
      throw new ShopifyGraphqlError(
        `Shopify Admin GraphQL returned a non-JSON body (HTTP ${httpStatus}).`,
        [{ message: 'Invalid JSON response' }],
        httpStatus,
      );
    }
    const b = body as { data?: unknown; errors?: unknown };
    const normalizedErrors: ShopifyGraphqlErrorItem[] = Array.isArray(b.errors)
      ? b.errors.map((row) => {
          if (row && typeof row === 'object') {
            const r = row as { message?: string; extensions?: unknown; locations?: unknown };
            return {
              message:
                typeof r.message === 'string' ? r.message : JSON.stringify(row).slice(0, 300),
              extensions:
                r.extensions && typeof r.extensions === 'object'
                  ? (r.extensions as Record<string, unknown>)
                  : undefined,
              locations: r.locations,
            };
          }
          return { message: String(row) };
        })
      : typeof b.errors === 'string'
        ? [{ message: b.errors }]
        : [];
    return { data: b.data, errors: normalizedErrors };
  }

  private async executeGraphqlOnce(
    domain: string,
    token: string,
    apiVersion: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await fetch(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
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
        (typeof json === 'object' && json !== null && 'errors' in (json as object)
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
    return data;
  }

  async adminGraphql<T = unknown>(
    domain: string,
    token: string,
    query: string,
    variables?: Record<string, unknown>,
    apiVersion = '2024-10',
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < DEFAULT_GRAPHQL_ATTEMPTS; attempt++) {
      try {
        return (await this.executeGraphqlOnce(domain, token, apiVersion, query, variables)) as T;
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

  async adminRest(
    domain: string,
    token: string,
    path: string,
    init?: RequestInit,
    apiVersion = '2024-10',
  ): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < DEFAULT_GRAPHQL_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`https://${domain}/admin/api/${apiVersion}/${path.replace(/^\//, '')}`, {
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
        const body = payload as Record<string, unknown>;
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
