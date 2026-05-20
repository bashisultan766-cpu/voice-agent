# Tenant isolation audit

## Rule

For any entity that belongs to a tenant, **never** resolve it by `id` alone when the `id` comes from the client. Always scope by `tenantId` (from header or auth).

## Safe patterns

```ts
// OK: tenant from context
const doc = await this.prisma.knowledgeDocument.findFirst({
  where: { id: documentId, tenantId },
});

// OK: tenantId in where
const session = await this.prisma.callSession.findFirst({
  where: { id: callSessionId, tenantId },
});
```

## Unsafe patterns

```ts
// BAD: id-only fetch for tenant-scoped entity (allows cross-tenant access if id is guessed)
const session = await this.prisma.callSession.findUnique({
  where: { id: callSessionId },
});
```

## Controllers

- All analytics, knowledge, QA, and tenant-scoped APIs must require `x-tenant-id` (or future auth) and pass `tenantId` into services.
- Use `TenantGuard` on routes that must be tenant-scoped; read `req.tenantId` in the controller.

## Internal vs external id

- **Internal**: When the server itself obtained the entity (e.g. from a prior tenant-scoped query or from a webhook that already identified the tenant), using `findUnique` by id only is acceptable as long as that id was not taken from an unvalidated client input.
- **External**: Any `id` coming from request body, query, or params must be used only with a tenant-scoped query (`findFirst({ where: { id, tenantId } })`).

## Checklist

- [ ] Knowledge: create/read/update/delete use tenantId.
- [ ] Analytics: overview/agents/stores/tools and QA use tenantId.
- [ ] Calls: findOne used by internal runtime only; external GET /calls/:id should require tenant and scope by tenantId.
- [ ] Stores, agents, phone numbers: all tenant-scoped.
- [ ] Vector store and file storage keys include tenant (and store) prefix.
