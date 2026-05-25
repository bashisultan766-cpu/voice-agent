import { Injectable } from '@nestjs/common';
import { KnowledgeDocType } from '@prisma/client';
import type { VoiceAgentRuntimeConfig } from '@bookstore-voice-agents/types';
import { RetrievalService } from '../../knowledge/retrieval.service';
import { RetrievalOrchestratorService } from '../../knowledge/retrieval-orchestrator.service';
import { classifyPolicyTopic, type PolicyTopic } from './policy-intent.util';

export type PolicyPrefetchInput = {
  tenantId: string;
  storeId: string;
  customerText: string;
  topic?: PolicyTopic | null;
  config?: VoiceAgentRuntimeConfig | null;
  returnRefundBehavior?: string | null;
};

@Injectable()
export class PolicyContextPrefetchService {
  constructor(
    private readonly retrieval: RetrievalService,
    private readonly retrievalOrchestrator: RetrievalOrchestratorService,
  ) {}

  async prefetch(input: PolicyPrefetchInput): Promise<string | null> {
    const topic = input.topic ?? classifyPolicyTopic(input.customerText);
    if (!topic) return null;

    try {
      const fromKb = await this.fetchFromKnowledge(input, topic);
      if (fromKb) return fromKb;
      return this.configFallback(input, topic);
    } catch {
      return this.configFallback(input, topic);
    }
  }

  private async fetchFromKnowledge(
    input: PolicyPrefetchInput,
    topic: PolicyTopic,
  ): Promise<string | null> {
    const { tenantId, storeId, customerText } = input;

    switch (topic) {
      case 'store_hours': {
        const hours = await this.retrieval.getStoreHours(tenantId, storeId);
        return this.formatVoiceSummary('Store hours', hours.voiceSummary, hours.items);
      }
      case 'shipping': {
        const ship = await this.retrieval.getPolicy(tenantId, storeId, KnowledgeDocType.SHIPPING_POLICY);
        const formatted = this.formatVoiceSummary('Shipping policy', ship.voiceSummary, ship.items);
        if (formatted) return formatted;
        break;
      }
      case 'refund': {
        const ret = await this.retrieval.getPolicy(tenantId, storeId, KnowledgeDocType.RETURN_POLICY);
        const formatted = this.formatVoiceSummary('Return/refund policy', ret.voiceSummary, ret.items);
        if (formatted) return formatted;
        break;
      }
      default:
        break;
    }

    try {
      const rag = await this.retrievalOrchestrator.retrieve({
        tenantId,
        storeId,
        query: customerText,
        topK: 4,
      });
      if (rag.ok && rag.items.length > 0) {
        const snippets = rag.items
          .slice(0, 3)
          .map((i) => i.snippet?.trim())
          .filter(Boolean)
          .join(' ');
        const summary = rag.voiceSummary?.trim() || snippets;
        if (summary) return `[${topic}] ${summary.slice(0, 900)}`;
      }
    } catch {
      /* FAQ fallback */
    }

    const faqs = await this.retrieval.searchFaqs(tenantId, storeId, customerText, undefined, 3);
    return this.formatVoiceSummary('FAQ', faqs.voiceSummary, faqs.items);
  }

  private configFallback(input: PolicyPrefetchInput, topic: PolicyTopic): string | null {
    const cfg = input.config;
    if (!cfg) return null;
    switch (topic) {
      case 'shipping':
        return cfg.shippingPolicy?.trim() || cfg.deliveryNotes?.trim() || null;
      case 'refund':
        return cfg.returnPolicy?.trim() || input.returnRefundBehavior?.trim() || null;
      default:
        return null;
    }
  }

  private formatVoiceSummary(
    label: string,
    voiceSummary?: string,
    items?: Array<{ snippet?: string }>,
  ): string | null {
    const summary = voiceSummary?.trim();
    if (summary && summary !== 'Policy not configured.' && summary !== 'Hours not set') {
      return `[${label}] ${summary.slice(0, 900)}`;
    }
    const snippets = (items ?? [])
      .map((i) => i.snippet?.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' ');
    if (snippets) return `[${label}] ${snippets.slice(0, 900)}`;
    return null;
  }
}
