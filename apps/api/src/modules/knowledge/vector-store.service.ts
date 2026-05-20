import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../../database/prisma.service';

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 60; // ~2 min
const DEFAULT_CHUNK_SIZE = Number(process.env.KNOWLEDGE_CHUNK_SIZE) || 700;
const DEFAULT_CHUNK_OVERLAP = Number(process.env.KNOWLEDGE_CHUNK_OVERLAP) || 120;

export interface VectorSearchResult {
  id: string;
  text: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class VectorStoreService {
  private client: OpenAI | null = null;
  private enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {
    const apiKey = this.config?.get<string>('OPENAI_API_KEY') ?? process.env.OPENAI_API_KEY;
    this.enabled =
      (this.config?.get<string>('OPENAI_VECTOR_STORE_ENABLED') ?? process.env.OPENAI_VECTOR_STORE_ENABLED) === 'true' &&
      Boolean(apiKey);
    if (apiKey) this.client = new OpenAI({ apiKey });
  }

  isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }

  private get vectorStores(): {
    create: (o: object) => Promise<{ id: string }>;
    files: { create: (vsId: string, o: object) => Promise<{ id: string }>; retrieve: (vsId: string, fId: string) => Promise<{ status: string }>; del: (vsId: string, fId: string) => Promise<unknown> };
    search?: (vsId: string, o: { query: string; max_num_results?: number }) => Promise<{ data?: Array<{ id?: string; content?: string[]; score?: number; metadata?: object }> }> | AsyncIterable<{ file_id?: string; content?: Array<{ text?: string }>; score?: number }>;
  } | null {
    const c = this.client as unknown as { beta?: { vectorStores: unknown } };
    return (c?.beta?.vectorStores as typeof this.vectorStores) ?? null;
  }

  /**
   * Get or create a vector store for a store. One vector store per store (tenant-scoped).
   */
  async getOrCreateVectorStoreForStore(tenantId: string, storeId: string): Promise<string | null> {
    if (!this.client) return null;
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, tenantId },
      select: { id: true, name: true },
    });
    if (!store) return null;

    const existing = await this.prisma.knowledgeDocument.findFirst({
      where: { tenantId, storeId, vectorStoreId: { not: null } },
      select: { vectorStoreId: true },
    });
    if (existing?.vectorStoreId) return existing.vectorStoreId;

    const vsApi = this.vectorStores;
    if (!vsApi) return null;
    const vs = await vsApi.create({
      name: `kb-${storeId.slice(-8)}`,
      metadata: { tenantId, storeId },
      chunking_strategy: {
        type: 'static',
        static: {
          max_chunk_size_tokens: DEFAULT_CHUNK_SIZE,
          chunk_overlap_tokens: DEFAULT_CHUNK_OVERLAP,
        },
      },
    });
    return vs.id;
  }

  /**
   * Upload file to OpenAI Files API, then attach to vector store. Returns vector file id.
   */
  async uploadAndAttach(
    vectorStoreId: string,
    fileBuffer: Buffer,
    fileName: string,
    metadata?: Record<string, string>,
  ): Promise<{ fileId: string; vectorFileId: string } | null> {
    if (!this.client) return null;
    const tmpPath = path.join(os.tmpdir(), `kb-${Date.now()}-${fileName}`);
    try {
      fs.writeFileSync(tmpPath, fileBuffer);
      const file = await this.client.files.create({
        file: fs.createReadStream(tmpPath) as unknown as File,
        purpose: 'assistants',
      });
      const vsApi = this.vectorStores;
      if (!vsApi) return null;
      const attrs = metadata ? { metadata: metadata as Record<string, string> } : {};
      const vf = await vsApi.files.create(vectorStoreId, {
        file_id: file.id,
        ...attrs,
      });
      return { fileId: file.id, vectorFileId: vf.id };
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  /**
   * Poll vector store file status until completed or failed.
   */
  async waitUntilProcessed(vectorStoreId: string, vectorFileId: string): Promise<'completed' | 'failed'> {
    const vsApi = this.vectorStores;
    if (!vsApi) return 'failed';
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      const vf = await vsApi.files.retrieve(vectorStoreId, vectorFileId);
      if (vf.status === 'completed') return 'completed';
      if (vf.status === 'failed' || vf.status === 'cancelled') return 'failed';
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return 'failed';
  }

  /**
   * Search vector store by query. Returns relevant chunks (top K).
   */
  async search(
    vectorStoreId: string,
    query: string,
    options?: { topK?: number; metadataFilter?: Record<string, string> },
  ): Promise<VectorSearchResult[]> {
    const vsApi = this.vectorStores;
    if (!vsApi?.search) return [];
    const topK = options?.topK ?? (Number(process.env.KNOWLEDGE_RETRIEVAL_TOP_K) || 5);
    try {
      const results = await vsApi.search(vectorStoreId, {
        query,
        max_num_results: Math.min(topK, 20),
      });
      const iter = Symbol.asyncIterator in Object(results) ? (results as AsyncIterable<{ content?: Array<{ text?: string }>; score?: number }>) : null;
      const out: VectorSearchResult[] = [];
      if (iter) {
        for await (const r of iter) {
          const text = Array.isArray(r.content) ? r.content.map((c) => c.text ?? '').join(' ') : '';
          if (text) out.push({ id: '', text, score: r.score });
        }
      } else if (typeof results === 'object' && results !== null && 'data' in results) {
        const data = (results as { data?: Array<{ id?: string; content?: string[]; score?: number }> }).data ?? [];
        data.forEach((r, i) => out.push({
          id: r.id ?? String(i),
          text: Array.isArray(r.content) ? r.content.join('\n') : '',
          score: r.score,
        }));
      }
      return out.slice(0, topK);
    } catch {
      return [];
    }
  }

  /**
   * Delete a file from the vector store (e.g. when document is archived).
   */
  async removeFile(vectorStoreId: string, vectorFileId: string): Promise<boolean> {
    const vsApi = this.vectorStores;
    if (!vsApi) return false;
    try {
      await vsApi.files.del(vectorStoreId, vectorFileId);
      return true;
    } catch {
      return false;
    }
  }
}
