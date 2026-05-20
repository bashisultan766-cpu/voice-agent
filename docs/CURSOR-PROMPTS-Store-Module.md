# Store Module — File-by-File Cursor Prompts

ہر prompt کو Cursor میں paste کریں، ایک ایک فائل کے لیے۔ پہلے **Composer/Agent mode** open کریں۔

---

## Prompt 1 — stores.module.ts

```
Create a new file at apps/api/src/modules/stores/stores.module.ts

Write the complete code into that file. Do not just show code in chat; create the file in the project.

Requirements:
- NestJS module named StoresModule
- Import and register StoresController and StoresService
- Export StoresService so other modules can use it
- Use @Module() decorator
- Keep it production-ready and minimal
```

---

## Prompt 2 — stores.controller.ts

```
Create a new file at apps/api/src/modules/stores/stores.controller.ts

Write the complete code into that file. Do not just show code in chat; create the file in the project.

Requirements:
- NestJS controller with route prefix "stores"
- Use JwtAuthGuard and a custom decorator @CurrentUser() to get RequestUser (userId, tenantId, role)
- Endpoints:
  - POST /api/stores — body: CreateStoreDto, tenant-scoped
  - GET /api/stores — list stores for current tenant, exclude soft-deleted
  - GET /api/stores/:id — get one store by id, only if it belongs to current tenant
  - PATCH /api/stores/:id — body: UpdateStoreDto (partial), tenant-scoped
  - DELETE /api/stores/:id — soft delete (set deletedAt), tenant-scoped
- All queries must enforce tenantId from current user
- Inject StoresService
- Use ParseUUIDPipe or similar for :id
```

---

## Prompt 3 — stores.service.ts

```
Create a new file at apps/api/src/modules/stores/stores.service.ts

Write the complete code into that file. Do not just show code in chat; create the file in the project.

Requirements:
- NestJS injectable service
- Inject PrismaService
- Methods: create(tenantId, dto), findAll(tenantId), findOne(tenantId, id), update(tenantId, id, dto), remove(tenantId, id)
- create: validate slug is unique per tenant, then prisma.store.create with tenantId
- findAll: where: { tenantId, deletedAt: null }, order by name
- findOne: findFirst where id and tenantId and deletedAt null, else throw NotFoundException
- update: same tenant check, then prisma.store.update
- remove: soft delete — prisma.store.update set deletedAt: new Date(), only if tenantId matches
- Never query by id alone; always include tenantId in where clause
```

---

## Prompt 4 — create-store.dto.ts

```
Create a new file at apps/api/src/modules/stores/dto/create-store.dto.ts

Write the complete code into that file. Do not just show code in chat; create the file in the project.

Requirements:
- Class CreateStoreDto
- Use class-validator: IsString, IsOptional, IsEmail, MinLength, MaxLength
- Fields: name (required), slug (required), city (optional), address (optional), phone (optional), email (optional), timezone (optional)
- slug: add @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) for kebab-case
- name: MinLength(1), MaxLength(255)
- Export the class
```

---

## Prompt 5 — update-store.dto.ts

```
Create a new file at apps/api/src/modules/stores/dto/update-store.dto.ts

Write the complete code into that file. Do not just show code in chat; create the file in the project.

Requirements:
- Class UpdateStoreDto
- Use PartialType from @nestjs/mapped-types or @nestjs/swagger: PartialType(CreateStoreDto) so all fields are optional
- If PartialType is not available, use IsOptional on each field: name?, slug?, city?, address?, phone?, email?, timezone?
- Same validation rules as CreateStoreDto but every field optional
- Export the class
```

---

## استعمال کا طریقہ

1. **Composer/Agent** open کریں (Ctrl+I یا Cmd+I)
2. پہلا prompt copy کر کے paste کریں → Apply/Accept کر کے فائل بننے دیں
3. اگلا prompt اسی طرح، ایک ایک فائل
4. اگر کسی فائل میں `RequestUser` یا `JwtAuthGuard` ابھی نہیں بنے، تو پہلے auth module والے prompts چلائیں، یا اس prompt میں لکھ دیں: "Assume RequestUser has userId and tenantId; use a placeholder guard if needed"

---

## Optional: RequestUser / Guard placeholders

اگر آپ نے ابھی auth module نہیں بنایا تو Prompt 2 میں یہ variant use کریں:

```
Create a new file at apps/api/src/modules/stores/stores.controller.ts

Write the complete code into that file. Create the file in the project.

Requirements:
- NestJS controller, route "stores"
- For now use a simple guard that sets request.user = { userId: 'placeholder', tenantId: 'placeholder', role: 'ADMIN' } for all requests (we will replace with Clerk JWT later)
- Endpoints: POST /api/stores, GET /api/stores, GET /api/stores/:id, PATCH /api/stores/:id, DELETE /api/stores/:id
- All call StoresService with tenantId from request.user.tenantId
- Use CreateStoreDto and UpdateStoreDto for body validation
```

پھر جب auth تیار ہو تو guard اور decorator replace کر دینا۔
