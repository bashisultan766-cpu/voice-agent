import { Injectable } from '@nestjs/common';
import { FaqService } from './faq.service';
import { BranchProfileService } from './branch-profile.service';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeDocType } from '@prisma/client';

export interface RetrievalItem {
  id: string;
  title?: string;
  snippet: string;
  score?: number;
  docType?: string;
  branchName?: string;
  city?: string;
}

export interface RetrievalResult {
  ok: boolean;
  source: 'faq' | 'branch_profile' | 'knowledge_document' | 'vector_store' | 'hybrid';
  items: RetrievalItem[];
  voiceSummary?: string;
}

@Injectable()
export class RetrievalService {
  constructor(
    private readonly faqService: FaqService,
    private readonly branchProfileService: BranchProfileService,
    private readonly knowledgeService: KnowledgeService,
  ) {}

  /**
   * Search FAQs for a store (and optional branch). Used by voice tools.
   */
  async searchFaqs(tenantId: string, storeId: string, query: string, branchProfileId?: string, topK = 5): Promise<RetrievalResult> {
    const faqs = await this.faqService.search(tenantId, storeId, query, branchProfileId, topK);
    return {
      ok: true,
      source: 'faq',
      items: faqs.map((f) => ({
        id: f.id,
        title: f.question,
        snippet: f.answer,
        docType: 'faq',
      })),
      voiceSummary: faqs.length > 0
        ? faqs.slice(0, 2).map((f) => f.answer).join(' ')
        : undefined,
    };
  }

  /**
   * Get branch profile(s) for a store. Used by get_branch_profile / get_store_hours.
   */
  async getBranchProfiles(tenantId: string, storeId: string, branchId?: string, city?: string): Promise<RetrievalResult> {
    const branches = await this.branchProfileService.getByStore(tenantId, storeId, branchId, city);
    return {
      ok: true,
      source: 'branch_profile',
      items: branches.map((b) => ({
        id: b.id,
        title: b.name,
        snippet: [b.address, b.phone, b.notes].filter(Boolean).join(' ') || 'No details',
        docType: 'branch_profile',
        branchName: b.name,
        city: b.city ?? undefined,
      })),
      voiceSummary:
        branches.length === 1
          ? this.formatBranchSummary(branches[0])
          : `${branches.length} branches found.`,
    };
  }

  /**
   * Get store hours from branch openingHoursJson.
   */
  async getStoreHours(tenantId: string, storeId: string, branchId?: string): Promise<RetrievalResult> {
    const branches = await this.branchProfileService.getByStore(tenantId, storeId, branchId);
    const items: RetrievalItem[] = [];
    for (const b of branches) {
      const hours = b.openingHoursJson as Record<string, string> | null;
      const snippet = hours
        ? Object.entries(hours)
            .map(([day, time]) => `${day}: ${time}`)
            .join('; ')
        : 'Hours not set';
      items.push({
        id: b.id,
        title: b.name,
        snippet,
        docType: 'branch_profile',
        branchName: b.name,
        city: b.city ?? undefined,
      });
    }
    return {
      ok: true,
      source: 'branch_profile',
      items,
      voiceSummary: items.length === 1 ? items[0].snippet : `${items.length} branches. ${items[0]?.snippet ?? ''}`,
    };
  }

  /**
   * Get promotion details from knowledge documents (type PROMOTION). Prefer summary for voice.
   */
  async getPromotionDetails(tenantId: string, storeId: string, branchProfileId?: string): Promise<RetrievalResult> {
    const docs = await this.knowledgeService.getByType(tenantId, storeId, KnowledgeDocType.PROMOTION, branchProfileId);
    const items: RetrievalItem[] = docs.map((d) => ({
      id: d.id,
      title: d.title,
      snippet: d.summary || d.content.slice(0, 500),
      docType: 'promotion',
    }));
    return {
      ok: true,
      source: 'knowledge_document',
      items,
      voiceSummary: (docs[0]?.summary || docs[0]?.content?.slice(0, 300)) ?? 'No current promotions.',
    };
  }

  /**
   * Get policy content (shipping/return) from knowledge documents. Prefer summary for voice.
   */
  async getPolicy(tenantId: string, storeId: string, type: KnowledgeDocType, branchProfileId?: string): Promise<RetrievalResult> {
    const docs = await this.knowledgeService.getByType(tenantId, storeId, type, branchProfileId);
    const items: RetrievalItem[] = docs.map((d) => ({
      id: d.id,
      title: d.title,
      snippet: d.summary || d.content.slice(0, 500),
      docType: d.type,
    }));
    const voiceSummary = docs[0]?.summary || docs[0]?.content?.slice(0, 300);
    return {
      ok: true,
      source: 'knowledge_document',
      items,
      voiceSummary: voiceSummary ?? 'Policy not configured.',
    };
  }

  private formatBranchSummary(b: { name: string; city?: string | null; address?: string | null; phone?: string | null }): string {
    const parts = [b.name];
    if (b.city) parts.push(b.city);
    if (b.address) parts.push(b.address);
    if (b.phone) parts.push(`Phone: ${b.phone}`);
    return parts.join(', ');
  }
}
