import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { VoiceSearchService } from '../voice-search.service';
import { VoiceAgentContextService } from './voice-agent-context.service';
import { findCatalogInventoryOverride } from '../data/voice-catalog-overrides.data';
import {
  inventoryConfirmedInStock,
  resolveInventoryStatus,
  type CatalogMatchType,
  type InventoryStatus,
} from '../utils/voice-inventory-status.util';
import { inventoryStatusPhrase, sanitizeCustomerFacingText } from '../utils/voice-agent-language.util';
import { normalizeVoiceText } from '../../shopify/voice-text-normalize.util';

export type CatalogSearchResult = {
  success: boolean;
  match_type: CatalogMatchType;
  query: string;
  inventory_status: InventoryStatus;
  product?: {
    productId: string;
    variantId: string;
    title: string;
    price: string | null;
    sku: string | null;
    inventory: number | null;
  };
  products?: Array<{
    productId: string;
    variantId: string;
    title: string;
    price: string | null;
    sku: string | null;
    inventory: number | null;
    inventory_status: InventoryStatus;
    score: number;
  }>;
  suggested_response: string;
  escalate?: boolean;
  escalation_reason?: string;
  error?: string;
  latencyMs?: number;
};

@Injectable()
export class VoiceCatalogService {
  private readonly logger = new Logger(VoiceCatalogService.name);

  constructor(
    private readonly voiceSearch: VoiceSearchService,
    private readonly agentContext: VoiceAgentContextService,
  ) {}

  async searchCatalog(args: {
    query: string;
    tenantId?: string;
    agentId?: string;
    callerPhone?: string;
    callSid?: string;
    limit?: number;
  }): Promise<CatalogSearchResult> {
    const started = Date.now();
    const query = args.query?.trim() ?? '';
    if (!query) throw new BadRequestException('query is required.');

    await this.agentContext.resolveAgentContext(args.tenantId, args.agentId);

    const override = findCatalogInventoryOverride(query);
    if (override) {
      const suggested = sanitizeCustomerFacingText(inventoryStatusPhrase(override.status));
      this.logSearch(args, query, 'exact', override.status, Date.now() - started);
      return {
        success: true,
        match_type: 'exact',
        query,
        inventory_status: override.status,
        product: {
          productId: '',
          variantId: '',
          title: query,
          price: null,
          sku: null,
          inventory: 0,
        },
        suggested_response: suggested,
        latencyMs: Date.now() - started,
      };
    }

    try {
      const result = await this.voiceSearch.searchProduct({
        query,
        tenantId: args.tenantId,
        agentId: args.agentId,
        limit: args.limit ?? 5,
      });

      if (!result.success || !result.products.length) {
        const suggested =
          'I could not find that title in our catalog. I will connect you with customer service to check availability.';
        this.logSearch(args, query, 'not_found', 'unknown', Date.now() - started);
        return {
          success: true,
          match_type: 'not_found',
          query,
          inventory_status: 'unknown',
          suggested_response: suggested,
          escalate: true,
          escalation_reason: 'book_not_listed',
          latencyMs: Date.now() - started,
        };
      }

      const normalizedQuery = normalizeVoiceText(query);
      const top = result.products[0];
      const titleOverride = findCatalogInventoryOverride(top.title);
      const inventoryStatus = titleOverride?.status
        ?? resolveInventoryStatus({
          inventory: top.inventory,
          availableForSale: top.inStock ? true : top.inventory <= 0 ? false : null,
        });

      const exactMatch =
        normalizeVoiceText(top.title) === normalizedQuery ||
        top.matchedTokens?.some((t) => normalizedQuery.includes(normalizeVoiceText(t)));
      const matchType: CatalogMatchType = exactMatch ? 'exact' : 'fuzzy';

      const products = result.products.map((p) => {
        const pOverride = findCatalogInventoryOverride(p.title);
        const status =
          pOverride?.status ??
          resolveInventoryStatus({
            inventory: p.inventory,
            availableForSale: p.inStock ? true : p.inventory <= 0 ? false : null,
          });
        return {
          productId: p.productId,
          variantId: p.variantId,
          title: p.title,
          price: p.price,
          sku: p.sku,
          inventory: p.inventory ?? null,
          inventory_status: status,
          score: p.score,
        };
      });

      const topStatus = products[0].inventory_status;
      let suggested = inventoryStatusPhrase(topStatus);
      if (topStatus === 'in_stock' && top.price) {
        suggested = `${top.title} is ${top.price}. ${suggested}`;
      }
      if (topStatus === 'unknown') {
        suggested =
          'I need customer service to confirm current inventory for this title. Let me connect you with our team.';
      }

      this.logSearch(args, query, matchType, topStatus, Date.now() - started);

      return {
        success: true,
        match_type: matchType,
        query,
        inventory_status: topStatus,
        product: {
          productId: top.productId,
          variantId: top.variantId,
          title: top.title,
          price: top.price,
          sku: top.sku,
          inventory: inventoryConfirmedInStock(topStatus) ? top.inventory : top.inventory ?? 0,
        },
        products,
        suggested_response: sanitizeCustomerFacingText(suggested),
        escalate: topStatus === 'unknown',
        escalation_reason: topStatus === 'unknown' ? 'unknown_inventory' : undefined,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        JSON.stringify({
          event: 'tool_failed',
          tool: 'catalog-search',
          message: message.slice(0, 400),
          callSid: args.callSid ?? null,
        }),
      );
      return {
        success: false,
        match_type: 'not_found',
        query,
        inventory_status: 'unknown',
        suggested_response:
          'I could not check inventory right now. Please hold while I connect you with customer service.',
        error: message,
        escalate: true,
        escalation_reason: 'tool_failure',
        latencyMs: Date.now() - started,
      };
    }
  }

  private logSearch(
    args: { callSid?: string; callerPhone?: string },
    query: string,
    matchType: CatalogMatchType,
    status: InventoryStatus,
    latencyMs: number,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'voice.catalog.search',
        query: query.slice(0, 80),
        matchType,
        inventoryStatus: status,
        callSid: args.callSid ?? null,
        latencyMs,
      }),
    );
  }
}
