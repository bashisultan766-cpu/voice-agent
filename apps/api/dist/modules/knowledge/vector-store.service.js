"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VectorStoreService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const openai_1 = require("openai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const prisma_service_1 = require("../../database/prisma.service");
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 60;
const DEFAULT_CHUNK_SIZE = Number(process.env.KNOWLEDGE_CHUNK_SIZE) || 700;
const DEFAULT_CHUNK_OVERLAP = Number(process.env.KNOWLEDGE_CHUNK_OVERLAP) || 120;
let VectorStoreService = class VectorStoreService {
    constructor(prisma, config) {
        this.prisma = prisma;
        this.config = config;
        this.client = null;
        const apiKey = this.config?.get('OPENAI_API_KEY') ?? process.env.OPENAI_API_KEY;
        this.enabled =
            (this.config?.get('OPENAI_VECTOR_STORE_ENABLED') ?? process.env.OPENAI_VECTOR_STORE_ENABLED) === 'true' &&
                Boolean(apiKey);
        if (apiKey)
            this.client = new openai_1.default({ apiKey });
    }
    isEnabled() {
        return this.enabled && this.client !== null;
    }
    get vectorStores() {
        const c = this.client;
        return c?.beta?.vectorStores ?? null;
    }
    async getOrCreateVectorStoreForStore(tenantId, storeId) {
        if (!this.client)
            return null;
        const store = await this.prisma.store.findFirst({
            where: { id: storeId, tenantId },
            select: { id: true, name: true },
        });
        if (!store)
            return null;
        const existing = await this.prisma.knowledgeDocument.findFirst({
            where: { tenantId, storeId, vectorStoreId: { not: null } },
            select: { vectorStoreId: true },
        });
        if (existing?.vectorStoreId)
            return existing.vectorStoreId;
        const vsApi = this.vectorStores;
        if (!vsApi)
            return null;
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
    async uploadAndAttach(vectorStoreId, fileBuffer, fileName, metadata) {
        if (!this.client)
            return null;
        const tmpPath = path.join(os.tmpdir(), `kb-${Date.now()}-${fileName}`);
        try {
            fs.writeFileSync(tmpPath, fileBuffer);
            const file = await this.client.files.create({
                file: fs.createReadStream(tmpPath),
                purpose: 'assistants',
            });
            const vsApi = this.vectorStores;
            if (!vsApi)
                return null;
            const attrs = metadata ? { metadata: metadata } : {};
            const vf = await vsApi.files.create(vectorStoreId, {
                file_id: file.id,
                ...attrs,
            });
            return { fileId: file.id, vectorFileId: vf.id };
        }
        finally {
            try {
                fs.unlinkSync(tmpPath);
            }
            catch { }
        }
    }
    async waitUntilProcessed(vectorStoreId, vectorFileId) {
        const vsApi = this.vectorStores;
        if (!vsApi)
            return 'failed';
        for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
            const vf = await vsApi.files.retrieve(vectorStoreId, vectorFileId);
            if (vf.status === 'completed')
                return 'completed';
            if (vf.status === 'failed' || vf.status === 'cancelled')
                return 'failed';
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        return 'failed';
    }
    async search(vectorStoreId, query, options) {
        const vsApi = this.vectorStores;
        if (!vsApi?.search)
            return [];
        const topK = options?.topK ?? (Number(process.env.KNOWLEDGE_RETRIEVAL_TOP_K) || 5);
        try {
            const results = await vsApi.search(vectorStoreId, {
                query,
                max_num_results: Math.min(topK, 20),
            });
            const iter = Symbol.asyncIterator in Object(results) ? results : null;
            const out = [];
            if (iter) {
                for await (const r of iter) {
                    const text = Array.isArray(r.content) ? r.content.map((c) => c.text ?? '').join(' ') : '';
                    if (text)
                        out.push({ id: '', text, score: r.score });
                }
            }
            else if (typeof results === 'object' && results !== null && 'data' in results) {
                const data = results.data ?? [];
                data.forEach((r, i) => out.push({
                    id: r.id ?? String(i),
                    text: Array.isArray(r.content) ? r.content.join('\n') : '',
                    score: r.score,
                }));
            }
            return out.slice(0, topK);
        }
        catch {
            return [];
        }
    }
    async removeFile(vectorStoreId, vectorFileId) {
        const vsApi = this.vectorStores;
        if (!vsApi)
            return false;
        try {
            await vsApi.files.del(vectorStoreId, vectorFileId);
            return true;
        }
        catch {
            return false;
        }
    }
};
exports.VectorStoreService = VectorStoreService;
exports.VectorStoreService = VectorStoreService = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        config_1.ConfigService])
], VectorStoreService);
//# sourceMappingURL=vector-store.service.js.map