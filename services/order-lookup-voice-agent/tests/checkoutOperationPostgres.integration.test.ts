/**
 * Postgres CheckoutOperationRepository integration tests.
 *
 * Skipped by default. Set DATABASE_URL to a Postgres instance (test schema)
 * and run `npm run test:integration` to exercise the full multi-instance
 * durable ledger behaviour.
 *
 * The suite creates the checkout_operations table from
 * migrations/004_checkout_operations.sql (idempotent), then TRUNCATES it
 * between tests so runs are isolated. Two distinct
 * PostgresCheckoutOperationRepository instances share the same schema to
 * simulate two horizontally-scaled workers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const HAS_DB = Boolean(DATABASE_URL);

// Skip the whole suite when no DATABASE_URL is provided. This keeps the fast
// unit-test path (`npm test`) clean while enabling operators to run the
// durable battery on demand.
const describeIfDb = HAS_DB ? describe : describe.skip;

let PostgresCheckoutOperationRepository: typeof import("../src/platform/postgresCheckoutOperationRepository.js").PostgresCheckoutOperationRepository;
let queryPostgres: typeof import("../src/platform/postgresEventStore.js").queryPostgres;
let initPostgresEventStore: typeof import("../src/platform/postgresEventStore.js").initPostgresEventStore;
let resetPostgresEventStoreState: typeof import("../src/platform/postgresEventStore.js").resetPostgresEventStoreState;
let closePostgresPool: typeof import("../src/platform/postgresEventStore.js").closePostgresPool;

function readForwardMigration(name: string): string {
  const dir = pathResolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  return readFileSync(pathResolve(dir, name), "utf8");
}

describeIfDb("checkoutOperationPostgres.integration", () => {
  beforeAll(async () => {
    const eventStore = await import("../src/platform/postgresEventStore.js");
    initPostgresEventStore = eventStore.initPostgresEventStore;
    queryPostgres = eventStore.queryPostgres;
    resetPostgresEventStoreState = eventStore.resetPostgresEventStoreState;
    closePostgresPool = eventStore.closePostgresPool;

    const repoMod = await import("../src/platform/postgresCheckoutOperationRepository.js");
    PostgresCheckoutOperationRepository = repoMod.PostgresCheckoutOperationRepository;

    resetPostgresEventStoreState();
    const ok = await initPostgresEventStore();
    if (!ok) {
      throw new Error("integration test: Postgres unreachable — set DATABASE_URL correctly");
    }
    // Apply forward migration idempotently.
    const sql = readForwardMigration("004_checkout_operations.sql");
    await queryPostgres(sql);
  });

  afterAll(async () => {
    if (queryPostgres) {
      await queryPostgres("DROP TABLE IF EXISTS checkout_operations CASCADE");
    }
    if (closePostgresPool) {
      await closePostgresPool();
    }
  });

  beforeEach(async () => {
    await queryPostgres("TRUNCATE checkout_operations");
  });

  function makeRepo() {
    return new PostgresCheckoutOperationRepository();
  }

  function baseRecord(overrides: Partial<import("../src/domain/checkoutOperation.js").CheckoutOperationRecord> = {}) {
    return {
      operationId: `op_${randomUUID().slice(0, 12)}`,
      idempotencyKey: `idem_${randomUUID().slice(0, 12)}`,
      checkoutPlanId: "plan_int",
      checkoutGroupId: "cg_int",
      attempt: 1,
      lifecycleStatus: "started" as const,
      expectedPlanVersion: 1,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  it("concurrent create with same idempotency_key converges on one row", async () => {
    const repoA = makeRepo();
    const repoB = makeRepo();
    const idem = `idem_${randomUUID().slice(0, 8)}`;
    const [a, b] = await Promise.all([
      repoA.create(baseRecord({ idempotencyKey: idem })),
      repoB.create(baseRecord({ idempotencyKey: idem })),
    ]);
    expect(a.idempotencyKey).toBe(idem);
    expect(b.idempotencyKey).toBe(idem);
    // Same durable row — operationId matches.
    expect(a.operationId).toBe(b.operationId);
    const all = await repoA.list();
    expect(all.filter((r) => r.idempotencyKey === idem)).toHaveLength(1);
  });

  it("worker A creates, worker B resumes via idempotency lookup", async () => {
    const repoA = makeRepo();
    const repoB = makeRepo();
    const idem = `idem_${randomUUID().slice(0, 8)}`;
    const created = await repoA.create(baseRecord({ idempotencyKey: idem, leaseOwnerId: "worker-A" }));
    const resumed = await repoB.findByIdempotencyKey(idem);
    expect(resumed?.operationId).toBe(created.operationId);
    expect(resumed?.leaseOwnerId).toBe("worker-A");
  });

  it("restart after draft_created rehydrates draft + invoice references", async () => {
    const repo = makeRepo();
    const idem = `idem_${randomUUID().slice(0, 8)}`;
    const created = await repo.create(baseRecord({ idempotencyKey: idem }));
    const draftUpdate = await repo.update(created.operationId, {
      lifecycleStatus: "draft_created",
      shopifyDraftOrderId: "#D-1",
      invoiceUrl: "https://checkout.example/inv-1",
      shopifyInvoiceReference: "https://checkout.example/inv-1",
    });
    expect(draftUpdate.ok).toBe(true);

    const restarted = makeRepo();
    const rehydrated = await restarted.findByIdempotencyKey(idem);
    expect(rehydrated?.lifecycleStatus).toBe("draft_created");
    expect(rehydrated?.shopifyDraftOrderId).toBe("#D-1");
    expect(rehydrated?.invoiceUrl).toBe("https://checkout.example/inv-1");
  });

  it("restart after invoice_sent surfaces completedAt + invoiceMessageId", async () => {
    const repo = makeRepo();
    const idem = `idem_${randomUUID().slice(0, 8)}`;
    const created = await repo.create(baseRecord({ idempotencyKey: idem }));
    await repo.update(created.operationId, {
      lifecycleStatus: "draft_created",
      shopifyDraftOrderId: "#D-2",
      invoiceUrl: "https://checkout.example/inv-2",
    });
    const invoice = await repo.update(created.operationId, {
      lifecycleStatus: "invoice_sent",
      invoiceMessageId: "msg-1",
      completedAt: Date.now(),
    });
    expect(invoice.ok).toBe(true);

    const restarted = makeRepo();
    const rehydrated = await restarted.findByIdempotencyKey(idem);
    expect(rehydrated?.lifecycleStatus).toBe("invoice_sent");
    expect(rehydrated?.invoiceMessageId).toBe("msg-1");
    expect(rehydrated?.completedAt).toBeGreaterThan(0);
  });

  it("stale lease token is rejected", async () => {
    const repo = makeRepo();
    const created = await repo.create(baseRecord({ leaseToken: "lease-real", leaseOwnerId: "worker-A" }));
    const rejected = await repo.update(
      created.operationId,
      { lifecycleStatus: "draft_created", shopifyDraftOrderId: "#D-X" },
      { expectedLeaseToken: "lease-forgery" },
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.reason).toBe("stale_lease");
    const post = await repo.findByIdempotencyKey(created.idempotencyKey);
    expect(post?.lifecycleStatus).toBe("started");
    expect(post?.shopifyDraftOrderId).toBeUndefined();
  });

  it("plan-version conflict rejects the writer", async () => {
    const repo = makeRepo();
    const created = await repo.create(baseRecord({ expectedPlanVersion: 5 }));
    const rejected = await repo.update(
      created.operationId,
      { lifecycleStatus: "invoice_sent" },
      { expectedPlanVersion: 99 },
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.reason).toBe("stale_plan");
  });

  it("concurrent invoice reconcile — only one write commits, other observes latest", async () => {
    const repo = makeRepo();
    const created = await repo.create(baseRecord({ expectedPlanVersion: 1 }));
    const [first, second] = await Promise.all([
      repo.update(
        created.operationId,
        { lifecycleStatus: "invoice_sent", invoiceMessageId: "concurrent-A" },
        { expectedStatus: "started" },
      ),
      repo.update(
        created.operationId,
        { lifecycleStatus: "invoice_sent", invoiceMessageId: "concurrent-B" },
        { expectedStatus: "started" },
      ),
    ]);
    const okResults = [first, second].filter((r) => r.ok);
    expect(okResults.length).toBe(1);
    const rehydrated = await repo.findByIdempotencyKey(created.idempotencyKey);
    expect(rehydrated?.lifecycleStatus).toBe("invoice_sent");
    expect(["concurrent-A", "concurrent-B"]).toContain(rehydrated?.invoiceMessageId);
  });

  it("TTL / recovery scenario: list returns operations in insertion order", async () => {
    const repo = makeRepo();
    const first = await repo.create(baseRecord({ checkoutGroupId: "cg-a" }));
    const second = await repo.create(baseRecord({ checkoutGroupId: "cg-b" }));
    const all = await repo.list();
    const operationIds = all.map((r) => r.operationId);
    expect(operationIds).toContain(first.operationId);
    expect(operationIds).toContain(second.operationId);
    expect(operationIds.indexOf(first.operationId)).toBeLessThan(
      operationIds.indexOf(second.operationId),
    );
  });

  it("ActionGateway with shared Postgres repo does not double-send", async () => {
    const gatewayMod = await import("../src/runtime/actionGateway.js");
    const domainMod = await import("../src/domain/checkoutModels.js");
    const emailMod = await import("../src/agents/emailConfirmationManager.js");
    const draftClient = await import("../src/infra/shopifyDraftOrderClient.js");
    const emailClient = await import("../src/infra/checkoutInvoiceEmailClient.js");
    const deliveryCfg = await import("../src/utils/emailDeliveryConfig.js");

    // Monkey-patch the infra clients so the durable ledger + shared Postgres
    // path is exercised without contacting real providers.
    let draftCalls = 0;
    let emailCalls = 0;
    const originalDraft = draftClient.createShopifyDraftOrder;
    const originalEmail = emailClient.sendCheckoutEmail;
    const originalConfigured = deliveryCfg.isEmailDeliveryConfigured;
    (draftClient as {
      createShopifyDraftOrder: typeof draftClient.createShopifyDraftOrder;
    }).createShopifyDraftOrder = async () => {
      draftCalls += 1;
      return {
        success: true,
        invoiceUrl: "https://checkout.example/int",
        draftOrderName: "#D-INT",
      };
    };
    (emailClient as {
      sendCheckoutEmail: typeof emailClient.sendCheckoutEmail;
    }).sendCheckoutEmail = async () => {
      emailCalls += 1;
      return { ok: true, messageId: `msg-${emailCalls}` };
    };
    (deliveryCfg as {
      isEmailDeliveryConfigured: typeof deliveryCfg.isEmailDeliveryConfigured;
    }).isEmailDeliveryConfigured = () => true;

    try {
      const session = {
        callSid: `CA_INT_${randomUUID().slice(0, 8)}`,
        from: "+15550001111",
        to: "+15550002222",
        phase: "cart_active",
        orderNumberAttempts: 0,
        createdAt: Date.now(),
        shoppingCart: [
          {
            variantId: "gid://shopify/ProductVariant/9001",
            productId: "gid://shopify/Product/9001",
            title: "Integration Book",
            quantity: 1,
            unitPrice: "12.34",
          },
        ],
      } as unknown as import("../src/types/order.js").CallSession;

      const lines = domainMod.cartLinesToGroupLines(session.shoppingCart!);
      const planned = domainMod.planCheckoutGroup(session, lines);
      if (!planned.ok) throw new Error(planned.message);
      const confirmed = emailMod.issueConfirmedEmail(session, "buyer@example.com", "payment_link");

      const repo = makeRepo();
      const idem = `idem_${randomUUID().slice(0, 8)}`;
      const first = await gatewayMod.ActionGateway.executeCheckoutGroup(
        {
          session,
          checkoutGroupId: planned.group.checkoutGroupId,
          confirmedEmailId: confirmed.confirmedEmailId,
          checkoutOperationRepository: repo,
        },
        { callId: session.callSid, actionId: "int_1", idempotencyKey: idem },
      );
      expect(first.ok).toBe(true);

      const secondRepo = makeRepo();
      const second = await gatewayMod.ActionGateway.executeCheckoutGroup(
        {
          session,
          checkoutGroupId: planned.group.checkoutGroupId,
          confirmedEmailId: confirmed.confirmedEmailId,
          checkoutOperationRepository: secondRepo,
        },
        { callId: session.callSid, actionId: "int_2", idempotencyKey: idem },
      );
      expect(second.ok).toBe(true);
      expect(draftCalls).toBe(1);
      expect(emailCalls).toBe(1);
    } finally {
      (draftClient as {
        createShopifyDraftOrder: typeof draftClient.createShopifyDraftOrder;
      }).createShopifyDraftOrder = originalDraft;
      (emailClient as {
        sendCheckoutEmail: typeof emailClient.sendCheckoutEmail;
      }).sendCheckoutEmail = originalEmail;
      (deliveryCfg as {
        isEmailDeliveryConfigured: typeof deliveryCfg.isEmailDeliveryConfigured;
      }).isEmailDeliveryConfigured = originalConfigured;
    }
  });
});
