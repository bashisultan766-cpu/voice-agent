# Stores module — file-by-file Cursor prompts

Use these prompts **one file at a time**. Create the file (or open it), then paste the prompt for that file. Ask Cursor to write **complete production-ready code** into the file. No pseudo-code, no long plan in the same message.

**Context for all prompts:** Multi-tenant SaaS for Shopify voice agents. Prisma schema has `Store` with `tenantId`, `slug` (unique per tenant), `city`, `address`, `phone`, `email`, `timezone`, `status` (StoreStatus enum: ACTIVE, INACTIVE, DISCONNECTED), `deletedAt`. All queries must be tenant-scoped. Use soft delete (set `deletedAt` instead of hard delete).

---

## 1. Create-store DTO

**File:** `apps/api/src/modules/stores/dto/create-store.dto.ts`

**Prompt:**

```
Write complete code directly into the currently open file.
Do not explain. Do not give pseudo-code. Do not give a plan.
Write production-ready NestJS DTO only.

Context: Multi-tenant SaaS for Shopify voice agents. Store has: name, slug, city?, address?, phone?, email?, timezone?, status?.

Requirements:
- Use class-validator: IsString, IsOptional, IsEnum, MaxLength.
- name: required string, max 255.
- slug: required string, max 100 (URL-safe).
- city, address, phone, email, timezone: optional string.
- status: optional enum StoreStatus (ACTIVE, INACTIVE, DISCONNECTED) from @prisma/client.
- Export class CreateStoreDto.
```

---

## 2. Update-store DTO

**File:** `apps/api/src/modules/stores/dto/update-store.dto.ts`

**Prompt:**

```
Write complete code directly into the currently open file.
Do not explain. Do not give pseudo-code.
Use PartialType from @nestjs/mapped-types (or class-validator) to make all fields of CreateStoreDto optional.
Import CreateStoreDto from ./create-store.dto.
Export class UpdateStoreDto.
```

---

## 3. Stores service

**File:** `apps/api/src/modules/stores/stores.service.ts`

**Prompt:**

```
Write complete code directly into the currently open file.
Do not explain. Do not give pseudo-code. Production-ready NestJS service only.

Context: Multi-tenant SaaS. Prisma Store model: tenantId, name, slug, city, address, phone, email, timezone, status, deletedAt. @@unique([tenantId, slug]).

Requirements:
- Constructor: inject PrismaService.
- create(tenantId: string, dto: CreateStoreDto): create store with tenantId; slug must be unique per tenant; throw ConflictException if slug duplicate.
- findAll(tenantId: string, status?: StoreStatus): findMany where tenantId and deletedAt: null; optional status filter; orderBy createdAt desc.
- findOne(tenantId: string, id: string): findFirst where id and tenantId and deletedAt null; throw NotFoundException if not found.
- update(tenantId: string, id: string, dto: UpdateStoreDto): verify findOne then update; if slug in dto, check unique per tenant.
- remove(tenantId: string, id: string): soft delete (set deletedAt: new Date()); verify findOne first.
- Use CreateStoreDto and UpdateStoreDto types. Import StoreStatus from @prisma/client.
```

---

## 4. Stores controller

**File:** `apps/api/src/modules/stores/stores.controller.ts`

**Prompt:**

```
Write complete code directly into the currently open file.
Do not explain. Do not give pseudo-code. Production-ready NestJS controller only.

Context: Multi-tenant SaaS. All store routes must be tenant-scoped. Tenant ID comes from header x-tenant-id (for now; later replace with auth).

Requirements:
- Controller path: stores.
- Inject StoresService.
- Private method getTenantId(headers): read x-tenant-id; throw BadRequestException if missing; return string.
- POST / : create store; body CreateStoreDto; use getTenantId(req.headers).
- GET / : list stores; query param status optional (StoreStatus); use getTenantId.
- GET /:id : get one store; use getTenantId; return from findOne.
- PATCH /:id : update store; body UpdateStoreDto; use getTenantId.
- DELETE /:id : soft delete; use getTenantId.
- Use ValidationPipe (optional). Import CreateStoreDto, UpdateStoreDto. Use @Headers() decorator for headers.
```

---

## 5. Stores module

**File:** `apps/api/src/modules/stores/stores.module.ts`

**Prompt:**

```
Write complete code directly into the currently open file.
Do not explain. Production-ready NestJS module only.

Requirements:
- Import Module from @nestjs/common.
- Declare StoresController.
- Providers: StoresService.
- Export StoresService.
- Import PrismaModule if StoresService needs Prisma (or rely on global PrismaModule).
```

---

## 6. Frontend: Stores table component

**File:** `apps/web/components/stores/stores-table.tsx`

**Prompt:**

```
Write complete code directly into the currently open file.
Do not explain. Production-ready React/Next.js component only.

Context: Dashboard for multi-tenant SaaS. List of stores: id, name, slug, city, status.

Requirements:
- Client component ('use client').
- Props: stores array (id, name, slug, city?, status).
- Table: columns Name, Slug, City, Status, Actions.
- Status: badge (ACTIVE green, INACTIVE gray, DISCONNECTED amber).
- Actions: link to /dashboard/stores/[id] (or edit) and optional delete button.
- Use Tailwind; clean table layout. No API call inside; data from parent.
```

---

## 7. Frontend: Create store dialog

**File:** `apps/web/components/stores/create-store-dialog.tsx`

**Prompt:**

```
Write complete code directly into the currently open file.
Do not explain. Production-ready React/Next.js component only.

Context: Dashboard for multi-tenant SaaS. Create new store: name, slug, optional city, address, phone, email, timezone.

Requirements:
- Client component. Controlled dialog (open, onOpenChange).
- Form fields: name (required), slug (required), city, address, phone, email, timezone (all optional).
- Submit: call API POST /api/stores with body { name, slug, ... } and header x-tenant-id (get tenant from env or context; or prop).
- On success: onSuccess callback and close dialog.
- Use Tailwind; simple form and button. Show loading on submit.
```

---

## 8. Frontend: Stores page

**File:** `apps/web/app/dashboard/stores/page.tsx`

**Prompt:**

```
Write complete code directly into the currently open file.
Do not explain. Production-ready Next.js page only.

Context: Dashboard stores list. Fetch stores from API; show table; button to open create dialog.

Requirements:
- Client component. On mount (or useEffect) fetch GET /api/stores with header x-tenant-id (use placeholder tenant id or env for now).
- State: stores list, loading, error.
- Render: page title "Stores", description, "Add store" button that opens CreateStoreDialog.
- Render StoresTable with stores. Pass onSuccess to dialog to refetch or push new store to state.
- Use Tailwind. Handle loading and error states.
```

---

## Execution order (backend first)

1. `dto/create-store.dto.ts`  
2. `dto/update-store.dto.ts`  
3. `stores.service.ts`  
4. `stores.controller.ts`  
5. `stores.module.ts`  

Then test API (e.g. Postman with x-tenant-id). Then frontend:

6. `components/stores/stores-table.tsx`  
7. `components/stores/create-store-dialog.tsx`  
8. `app/dashboard/stores/page.tsx`  

---

## Quick test checklist (Stores)

- [ ] POST /api/stores with x-tenant-id creates store; 400 if slug duplicate.
- [ ] GET /api/stores returns only that tenant's stores; optional ?status=ACTIVE works.
- [ ] GET /api/stores/:id returns one store; 404 if wrong tenant or not found.
- [ ] PATCH /api/stores/:id updates; 404 if wrong tenant.
- [ ] DELETE /api/stores/:id soft-deletes; GET no longer returns it.
- [ ] Dashboard stores page loads; table shows data; create dialog submits and list updates.
