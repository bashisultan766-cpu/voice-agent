/**
 * CheckoutOperation — durable execution record for one ActionGateway attempt
 * against a checkout group. Persisted BEFORE the external Shopify / Resend
 * calls so a crashed / restarted worker can safely resume without creating a
 * duplicate draft order or resending an invoice.
 *
 * Lifecycle status transitions (informational — enforced in ActionGateway):
 *   started → draft_created → invoice_sent
 *                             ↘  invoice_unknown  (network / timeout)
 *                             ↘  failed          (recoverable)
 *   started → failed
 *   started → draft_created → failed
 *
 * `expectedPlanVersion` is captured at STARTED and re-checked before every
 * mutation so a stale worker (whose plan diverged) cannot commit.
 */

export type CheckoutOperationLifecycleStatus =
  | "started"
  | "draft_created"
  | "invoice_sent"
  | "invoice_unknown"
  | "failed";

export interface CheckoutOperationRecord {
  operationId: string;
  idempotencyKey: string;
  checkoutPlanId: string;
  checkoutGroupId: string;
  attempt: number;
  /** Canonical TS field; maps to DB column `status`. */
  lifecycleStatus: CheckoutOperationLifecycleStatus;
  shopifyDraftOrderId?: string;
  invoiceUrl?: string;
  invoiceMessageId?: string;
  invoiceLastError?: string;
  expectedPlanVersion: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  /** Opaque lease token — matches FlowMutex lease so only the owner commits. */
  leaseToken?: string;
  /** Voice-turn correlation id (Twilio CallSid) — for tracing durable ops back to a call. */
  callId?: string;
  /** Identifier of the worker/lease owner that acquired this operation. */
  leaseOwnerId?: string;
  /** Consolidated Shopify invoice reference (URL / DraftOrder id / message id). */
  shopifyInvoiceReference?: string;
  /** External provider request id (Shopify GraphQL / Resend) — trace redaction target. */
  providerRequestId?: string;
  /** Structured error code from the last failed step. */
  lastErrorCode?: string;
  /** JSON metadata for reconciliation jobs (attempt counters, provider trace ids, etc). */
  reconciliationMetadata?: Record<string, unknown>;
  /** Non-secret payload fingerprint used for idempotency conflict detection. */
  payloadFingerprint?: string;
}

export interface CheckoutOperationUpdateGuard {
  expectedPlanVersion?: number;
  expectedStatus?: CheckoutOperationLifecycleStatus;
  expectedLeaseOwnerId?: string;
  expectedLeaseToken?: string;
}

export type CheckoutOperationUpdateFailure =
  | "not_found"
  | "stale_plan"
  | "stale_status"
  | "stale_lease";

export interface CheckoutOperationRepository {
  /**
   * Look up an existing operation by idempotency key. Returns `undefined`
   * when no attempt has been persisted yet.
   */
  findByIdempotencyKey(idempotencyKey: string): Promise<CheckoutOperationRecord | undefined>;
  /**
   * Persist the STARTED record — MUST be called before creating a Shopify
   * draft order or sending an invoice.
   *
   * Concurrent workers with the same idempotencyKey must converge on a single
   * record; the underlying store enforces this via a unique constraint.
   */
  create(record: CheckoutOperationRecord): Promise<CheckoutOperationRecord>;
  /**
   * Partial update — implementations must merge fields and bump updatedAt.
   * Reject the write when the guard no longer matches the caller's snapshot
   * (stale worker guard). `expectedLeaseOwnerId` / `expectedLeaseToken`
   * enforce single-writer semantics across horizontally-scaled instances.
   */
  update(
    operationId: string,
    patch: Partial<CheckoutOperationRecord>,
    guard?: CheckoutOperationUpdateGuard,
  ): Promise<
    | { ok: true; record: CheckoutOperationRecord }
    | { ok: false; reason: CheckoutOperationUpdateFailure; record?: CheckoutOperationRecord }
  >;
  /** For tests and restart replay — iterate all persisted operations. */
  list(): Promise<CheckoutOperationRecord[]>;
  /** Test hook only. */
  clear(): Promise<void>;
}

/**
 * In-memory repository. Backed by a Map so recreating the instance simulates
 * a fresh process; the durable Map is captured in module-scope for a shared
 * store when tests want cross-instance persistence.
 */
export class InMemoryCheckoutOperationRepository implements CheckoutOperationRepository {
  private readonly store: Map<string, CheckoutOperationRecord>;

  constructor(shared?: Map<string, CheckoutOperationRecord>) {
    this.store = shared ?? new Map<string, CheckoutOperationRecord>();
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CheckoutOperationRecord | undefined> {
    for (const record of this.store.values()) {
      if (record.idempotencyKey === idempotencyKey) return { ...record };
    }
    return undefined;
  }

  async create(record: CheckoutOperationRecord): Promise<CheckoutOperationRecord> {
    // Idempotency-key uniqueness. Return the existing record so concurrent
    // creators converge on the same operation.
    for (const existing of this.store.values()) {
      if (existing.idempotencyKey === record.idempotencyKey) {
        return { ...existing };
      }
    }
    if (this.store.has(record.operationId)) {
      return { ...this.store.get(record.operationId)! };
    }
    const stored: CheckoutOperationRecord = {
      ...record,
      startedAt: record.startedAt || Date.now(),
      updatedAt: record.updatedAt || Date.now(),
    };
    this.store.set(record.operationId, stored);
    return { ...stored };
  }

  async update(
    operationId: string,
    patch: Partial<CheckoutOperationRecord>,
    guard?: CheckoutOperationUpdateGuard,
  ): Promise<
    | { ok: true; record: CheckoutOperationRecord }
    | { ok: false; reason: CheckoutOperationUpdateFailure; record?: CheckoutOperationRecord }
  > {
    const current = this.store.get(operationId);
    if (!current) return { ok: false, reason: "not_found" };
    if (
      guard?.expectedPlanVersion !== undefined &&
      guard.expectedPlanVersion !== current.expectedPlanVersion
    ) {
      return { ok: false, reason: "stale_plan", record: { ...current } };
    }
    if (
      guard?.expectedStatus !== undefined &&
      guard.expectedStatus !== current.lifecycleStatus
    ) {
      return { ok: false, reason: "stale_status", record: { ...current } };
    }
    if (
      guard?.expectedLeaseOwnerId !== undefined &&
      guard.expectedLeaseOwnerId !== current.leaseOwnerId
    ) {
      return { ok: false, reason: "stale_lease", record: { ...current } };
    }
    if (
      guard?.expectedLeaseToken !== undefined &&
      guard.expectedLeaseToken !== current.leaseToken
    ) {
      return { ok: false, reason: "stale_lease", record: { ...current } };
    }
    const next: CheckoutOperationRecord = {
      ...current,
      ...patch,
      operationId: current.operationId,
      updatedAt: Date.now(),
    };
    this.store.set(operationId, next);
    return { ok: true, record: { ...next } };
  }

  async list(): Promise<CheckoutOperationRecord[]> {
    return [...this.store.values()].map((record) => ({ ...record }));
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

/**
 * Process-wide default repository. In production a Postgres-backed
 * implementation can replace this via `setDefaultCheckoutOperationRepository`.
 */
let defaultRepository: CheckoutOperationRepository = new InMemoryCheckoutOperationRepository();
let defaultRepositorySharedStore: Map<string, CheckoutOperationRecord> | null = null;

export function getDefaultCheckoutOperationRepository(): CheckoutOperationRepository {
  return defaultRepository;
}

export function setDefaultCheckoutOperationRepository(
  repository: CheckoutOperationRepository,
): void {
  defaultRepository = repository;
}

/** Reset the default repository, optionally rebinding to a stable shared Map. */
export function resetDefaultCheckoutOperationRepository(options?: {
  keepStore?: boolean;
}): CheckoutOperationRepository {
  if (options?.keepStore) {
    if (!defaultRepositorySharedStore) {
      defaultRepositorySharedStore = new Map<string, CheckoutOperationRecord>();
    }
    defaultRepository = new InMemoryCheckoutOperationRepository(defaultRepositorySharedStore);
  } else {
    defaultRepositorySharedStore = null;
    defaultRepository = new InMemoryCheckoutOperationRepository();
  }
  return defaultRepository;
}
