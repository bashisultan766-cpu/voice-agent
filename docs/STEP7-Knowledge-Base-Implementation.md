# Step 7 — Knowledge Base + Policies + Branch-Specific Answers

**Scope:** Structured KB (FAQs, branch profiles, knowledge documents), retrieval service, vector store (OpenAI), retrieval orchestrator, and voice tools so the agent answers policy, FAQ, branch, store-hours, and promotions from DB + optional vector search.

---

## 1. What Was Implemented

### 1.1 Prisma

- **KnowledgeStatus** enum: DRAFT, ACTIVE, ARCHIVED.
- **KnowledgeDocType:** FAQ, POLICY, SHIPPING_POLICY, RETURN_POLICY, STORE_INFO, BRANCH_INFO, DELIVERY_INFO, RETURNS_INFO, PROMOTION, HOLIDAY_HOURS, SOP, CUSTOM.
- **BranchProfile:** tenantId, storeId, branchCode, name, city, area, address, phone, whatsapp, email, openingHoursJson, pickupAvailable, deliveryAvailable, notes, isActive.
- **StoreFAQ:** tenantId, storeId, branchProfileId (optional), question, answer, language, tags, priority, isActive; **store** relation to Store.
- **KnowledgeDocument:** branchProfileId, status, language, summary, sourceFileId, vectorStoreId, vectorFileId, metadata, isVoiceOptimized, createdById.
- **KnowledgeSourceFile:** tenantId, storeId, fileName, mimeType, storageUrl, sizeBytes, uploadedById.
- **KnowledgeSyncJob:** tenantId, storeId, documentId, sourceFileId, vectorStoreId, vectorFileId, status (PENDING | PROCESSING | COMPLETED | FAILED), errorMessage, startedAt, completedAt.

Run: `pnpm --filter api prisma migrate dev --name step7_knowledge_sync_job`

### 1.2 Knowledge Module (`apps/api/src/modules/knowledge/`)

| File | Purpose |
|------|--------|
| `knowledge.module.ts` | Controller + FaqService, BranchProfileService, KnowledgeService, RetrievalService, VectorStoreService, KnowledgeIngestionService, RetrievalOrchestratorService. |
| `knowledge.controller.ts` | FAQs/branches/documents CRUD; POST /documents/:id/reindex, POST /documents/:id/archive; POST /search (orchestrator). |
| `faq.service.ts` | create, findAll, findOne, update, remove, search(tenantId, storeId, query, branchProfileId?, limit). |
| `branch-profile.service.ts` | create, findAll, findOne, update, remove, getByStore(tenantId, storeId, branchId?, city?). |
| `knowledge.service.ts` | create, findAll, findOne, update, remove, getByType(tenantId, storeId, type, branchProfileId?). |
| `retrieval.service.ts` | searchFaqs, getBranchProfiles, getStoreHours, getPolicy, **getPromotionDetails** — returns RetrievalResult. |
| `vector-store.service.ts` | getOrCreateVectorStoreForStore, uploadAndAttach, waitUntilProcessed, search, removeFile (OpenAI vector stores). |
| `knowledge-ingestion.service.ts` | syncDocumentToVectorStore(tenantId, documentId) — creates sync job, uploads content to vector store, updates document. |
| `retrieval-orchestrator.service.ts` | classify(query), retrieve({ tenantId, storeId, query, branchProfileId?, city?, topK? }) — routes to FAQ/branch/policy/vector. |
| DTOs | CreateFaqDto, UpdateFaqDto, CreateBranchProfileDto, UpdateBranchProfileDto, CreateKnowledgeDocumentDto, UpdateKnowledgeDocumentDto, SearchKnowledgeDto. |

**Tenant context:** All knowledge API requests require header `x-tenant-id` (replace with auth in production).

### 1.3 Voice Tools → Knowledge

- **get_store_locations** → RetrievalService.getBranchProfiles (branchId, city optional).
- **get_store_hours** → RetrievalService.getStoreHours (branchId optional).
- **search_store_faqs** → RetrievalService.searchFaqs (query, branchProfileId optional).
- **get_shipping_policy** → RetrievalService.getPolicy(SHIPPING_POLICY).
- **get_return_policy** → RetrievalService.getPolicy(RETURN_POLICY).
- **get_promotion_details** → RetrievalService.getPromotionDetails (branchProfileId optional).

Tool definitions in `openai/types/tool-definitions.ts`. Prompt in `openai-prompt-builder.service.ts` includes KB and branch-aware instructions (use FAQs, branch-scoped tools, policies, 1–3 sentence voice answers).

### 1.4 Retrieval Orchestrator

- **POST /api/knowledge/search** uses RetrievalOrchestratorService.retrieve(): classifies query (policy, branch_info, timing_location, faq, promotion, ambiguous), routes to DB lookups or vector search, returns normalized RetrievalResult with items and voiceSummary.
- Policy/long-doc queries can use vector store when OPENAI_VECTOR_STORE_ENABLED and document has vectorStoreId.

### 1.5 Flow

- Admin adds FAQs and branch profiles via `/api/knowledge/faqs` and `/api/knowledge/branches`.
- Admin adds documents via `/api/knowledge/documents`; optionally **POST /documents/:id/reindex** to sync content to OpenAI vector store (one store per store).
- **POST /documents/:id/archive** sets status ARCHIVED.
- During a call, tools run retrieval (and vector search when configured); model gets items + voiceSummary for concise spoken answers.

---

## 2. API Endpoints Summary

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/knowledge/faqs | Create FAQ (body: storeId, question, answer, …) |
| GET | /api/knowledge/faqs | List FAQs (?storeId, branchProfileId, isActive) |
| GET | /api/knowledge/faqs/:id | Get one FAQ |
| PATCH | /api/knowledge/faqs/:id | Update FAQ |
| DELETE | /api/knowledge/faqs/:id | Delete FAQ |
| POST | /api/knowledge/branches | Create branch profile |
| GET | /api/knowledge/branches | List branches (?storeId, city, isActive) |
| GET | /api/knowledge/branches/:id | Get one branch |
| PATCH | /api/knowledge/branches/:id | Update branch |
| DELETE | /api/knowledge/branches/:id | Delete branch |
| POST | /api/knowledge/documents | Create knowledge document |
| GET | /api/knowledge/documents | List documents (?storeId, type, status) |
| GET | /api/knowledge/documents/:id | Get one document |
| PATCH | /api/knowledge/documents/:id | Update document |
| DELETE | /api/knowledge/documents/:id | Delete document |
| POST | /api/knowledge/documents/:id/reindex | Sync document to vector store |
| POST | /api/knowledge/documents/:id/archive | Set document status to ARCHIVED |
| POST | /api/knowledge/search | Retrieval test (body: query, storeId, branchProfileId?, city?, topK?) — uses orchestrator |

All require header: `x-tenant-id`.

### Env vars (Step 7)

- `OPENAI_API_KEY` — required for vector store.
- `OPENAI_VECTOR_STORE_ENABLED` — set to `true` to enable vector store create/upload/search.
- `KNOWLEDGE_RETRIEVAL_TOP_K` — default 5.
- `KNOWLEDGE_CHUNK_SIZE` — default 700 (tokens).
- `KNOWLEDGE_CHUNK_OVERLAP` — default 120 (tokens).

---

## 3. Branch Profile openingHoursJson

Use a simple key-value format, e.g.:

```json
{
  "monday": "10:00-22:00",
  "tuesday": "10:00-22:00",
  "friday": "15:00-23:00",
  "sunday": "12:00-21:00"
}
```

`get_store_hours` returns this as snippet and voiceSummary for the model.

---

## 4. Policies (Voice-Friendly)

- Add KnowledgeDocument with type SHIPPING_POLICY or RETURN_POLICY, status ACTIVE.
- Set **summary** to a short, phone-friendly sentence; full text can go in **content**.
- Retrieval returns summary for voice when present, otherwise a slice of content.

---

## 5. Implementation Order Used

1. Prisma: BranchProfile, StoreFAQ, KnowledgeDocument updates, KnowledgeSourceFile, enums.
2. DTOs and FaqService, BranchProfileService, KnowledgeService.
3. RetrievalService (searchFaqs, getBranchProfiles, getStoreHours, getPolicy).
4. KnowledgeController and KnowledgeModule.
5. Tool definitions: get_store_hours, search_store_faqs, get_store_locations params.
6. CallsModule imports KnowledgeModule; ToolOrchestratorService injects RetrievalService and wires get_store_locations, get_store_hours, search_store_faqs, get_shipping_policy, get_return_policy to retrieval.

---

## 6. Dashboard UI

- **/dashboard/knowledge** — Overview with links to FAQs, Branch Profiles, Documents.
- **/dashboard/knowledge/faqs** — FAQ list (mock); filters All / Active.
- **/dashboard/knowledge/branches** — Branch list (mock); filters All / Active.
- **/dashboard/knowledge/documents** — Document list (mock); filters by type and status; Reindex / Archive actions.
- **/dashboard/stores/[id]/knowledge** — Store-specific knowledge center. Sidebar: Knowledge link added. Use real API hooks (x-tenant-id) when auth is wired.

---

## 7. Step 7 Done Checklist

- [ ] FAQ CRUD works with x-tenant-id.
- [ ] Branch profile CRUD works; openingHoursJson stored and returned.
- [ ] Knowledge documents CRUD works; type and status used.
- [ ] POST /api/knowledge/search uses orchestrator and returns relevant items (FAQ/branch/policy/vector).
- [ ] POST /api/knowledge/documents/:id/reindex syncs document to vector store when enabled.
- [ ] POST /api/knowledge/documents/:id/archive sets status ARCHIVED.
- [ ] Voice tools get_store_hours, get_shipping_policy, get_return_policy, get_promotion_details, search_store_faqs return data from DB (and vector when configured).
- [ ] Answers are concise and branch-aware; prompt includes KB and branch-aware instructions.
