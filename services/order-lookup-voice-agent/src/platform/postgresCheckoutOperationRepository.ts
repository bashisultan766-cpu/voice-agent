/**
 * Postgres-backed CheckoutOperationRepository — durable ledger for the
 * ActionGateway idempotency guarantee.
 *
 * Concurrent-writer contract:
 *   - `create` uses INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING *
 *     so two workers with the same idempotency_key converge on a single row.
 *   - `update` writes with WHERE clauses that verify expected_plan_version,
 *     expected_status, lease_owner_id, and lease_token so a stale worker
 *     cannot overwrite a healthy commit.
 *
 * All I/O flows through `queryPostgres` from postgresEventStore so a shared
 * pool and disable-on-failure semantics apply.
 */
import {
  type CheckoutOperationLifecycleStatus,
  type CheckoutOperationRecord,
  type CheckoutOperationRepository,
  type CheckoutOperationUpdateFailure,
  type CheckoutOperationUpdateGuard,
} from "../domain/checkoutOperation.js";
import { queryPostgres } from "./postgresEventStore.js";

interface CheckoutOperationRow {
  operation_id: string;
  idempotency_key: string;
  call_id: string | null;
  checkout_plan_id: string;
  checkout_group_id: string;
  attempt: number;
  status: CheckoutOperationLifecycleStatus;
  expected_plan_version: number;
  lease_owner_id: string | null;
  lease_token: string | null;
  shopify_draft_order_id: string | null;
  invoice_url: string | null;
  invoice_message_id: string | null;
  shopify_invoice_ref: string | null;
  provider_request_id: string | null;
  last_error_code: string | null;
  invoice_last_error: string | null;
  reconciliation_metadata: Record<string, unknown> | string | null;
  payload_fingerprint: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

function toEpoch(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}

function parseMetadata(
  value: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return value;
}

function rowToRecord(row: CheckoutOperationRow): CheckoutOperationRecord {
  return {
    operationId: row.operation_id,
    idempotencyKey: row.idempotency_key,
    checkoutPlanId: row.checkout_plan_id,
    checkoutGroupId: row.checkout_group_id,
    attempt: row.attempt,
    lifecycleStatus: row.status,
    shopifyDraftOrderId: row.shopify_draft_order_id ?? undefined,
    invoiceUrl: row.invoice_url ?? undefined,
    invoiceMessageId: row.invoice_message_id ?? undefined,
    invoiceLastError: row.invoice_last_error ?? undefined,
    expectedPlanVersion: row.expected_plan_version,
    startedAt: toEpoch(row.created_at),
    updatedAt: toEpoch(row.updated_at),
    completedAt: row.completed_at ? toEpoch(row.completed_at) : undefined,
    leaseToken: row.lease_token ?? undefined,
    callId: row.call_id ?? undefined,
    leaseOwnerId: row.lease_owner_id ?? undefined,
    shopifyInvoiceReference: row.shopify_invoice_ref ?? undefined,
    providerRequestId: row.provider_request_id ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    reconciliationMetadata: parseMetadata(row.reconciliation_metadata),
    payloadFingerprint: row.payload_fingerprint ?? undefined,
  };
}

const SELECT_COLUMNS = `
  operation_id, idempotency_key, call_id, checkout_plan_id, checkout_group_id,
  attempt, status, expected_plan_version, lease_owner_id, lease_token,
  shopify_draft_order_id, invoice_url, invoice_message_id, shopify_invoice_ref,
  provider_request_id, last_error_code, invoice_last_error,
  reconciliation_metadata, payload_fingerprint,
  created_at, updated_at, completed_at
`.trim();

export class PostgresCheckoutOperationRepository implements CheckoutOperationRepository {
  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CheckoutOperationRecord | undefined> {
    const result = await queryPostgres<CheckoutOperationRow>(
      `SELECT ${SELECT_COLUMNS} FROM checkout_operations WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey],
    );
    const row = result?.rows?.[0];
    return row ? rowToRecord(row) : undefined;
  }

  async create(record: CheckoutOperationRecord): Promise<CheckoutOperationRecord> {
    const inserted = await queryPostgres<CheckoutOperationRow>(
      `INSERT INTO checkout_operations (
         operation_id, idempotency_key, call_id, checkout_plan_id, checkout_group_id,
         attempt, status, expected_plan_version, lease_owner_id, lease_token,
         shopify_draft_order_id, invoice_url, invoice_message_id, shopify_invoice_ref,
         provider_request_id, last_error_code, invoice_last_error,
         reconciliation_metadata, payload_fingerprint, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18::jsonb, $19, to_timestamp($20 / 1000.0), to_timestamp($21 / 1000.0)
       )
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        record.operationId,
        record.idempotencyKey,
        record.callId ?? null,
        record.checkoutPlanId,
        record.checkoutGroupId,
        record.attempt,
        record.lifecycleStatus,
        record.expectedPlanVersion,
        record.leaseOwnerId ?? null,
        record.leaseToken ?? null,
        record.shopifyDraftOrderId ?? null,
        record.invoiceUrl ?? null,
        record.invoiceMessageId ?? null,
        record.shopifyInvoiceReference ?? record.invoiceUrl ?? null,
        record.providerRequestId ?? null,
        record.lastErrorCode ?? null,
        record.invoiceLastError ?? null,
        JSON.stringify(record.reconciliationMetadata ?? {}),
        record.payloadFingerprint ?? null,
        record.startedAt || Date.now(),
        record.updatedAt || Date.now(),
      ],
    );

    if (inserted && inserted.rows.length > 0) {
      return rowToRecord(inserted.rows[0]!);
    }

    // A concurrent worker inserted first — return the durable winner so both
    // callers converge on identical state.
    const existing = await this.findByIdempotencyKey(record.idempotencyKey);
    if (existing) return existing;
    throw new Error(
      "postgres_checkout_operation_repository: insert returned no row and no existing record found",
    );
  }

  async update(
    operationId: string,
    patch: Partial<CheckoutOperationRecord>,
    guard?: CheckoutOperationUpdateGuard,
  ): Promise<
    | { ok: true; record: CheckoutOperationRecord }
    | { ok: false; reason: CheckoutOperationUpdateFailure; record?: CheckoutOperationRecord }
  > {
    // Build SET clause dynamically over the whitelisted patchable fields so the
    // caller can update partial state without clobbering unrelated columns.
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    const push = (fragment: string, value: unknown): void => {
      sets.push(fragment.replace("$$", `$${idx}`));
      params.push(value);
      idx += 1;
    };

    if (patch.lifecycleStatus !== undefined) push("status = $$", patch.lifecycleStatus);
    if (patch.attempt !== undefined) push("attempt = $$", patch.attempt);
    if (patch.expectedPlanVersion !== undefined)
      push("expected_plan_version = $$", patch.expectedPlanVersion);
    if (patch.leaseOwnerId !== undefined) push("lease_owner_id = $$", patch.leaseOwnerId);
    if (patch.leaseToken !== undefined) push("lease_token = $$", patch.leaseToken);
    if (patch.shopifyDraftOrderId !== undefined)
      push("shopify_draft_order_id = $$", patch.shopifyDraftOrderId);
    if (patch.invoiceUrl !== undefined) push("invoice_url = $$", patch.invoiceUrl);
    if (patch.invoiceMessageId !== undefined)
      push("invoice_message_id = $$", patch.invoiceMessageId);
    if (patch.shopifyInvoiceReference !== undefined)
      push("shopify_invoice_ref = $$", patch.shopifyInvoiceReference);
    if (patch.providerRequestId !== undefined)
      push("provider_request_id = $$", patch.providerRequestId);
    if (patch.lastErrorCode !== undefined) push("last_error_code = $$", patch.lastErrorCode);
    if (patch.invoiceLastError !== undefined)
      push("invoice_last_error = $$", patch.invoiceLastError);
    if (patch.reconciliationMetadata !== undefined) {
      sets.push(`reconciliation_metadata = $${idx}::jsonb`);
      params.push(JSON.stringify(patch.reconciliationMetadata ?? {}));
      idx += 1;
    }
    if (patch.payloadFingerprint !== undefined)
      push("payload_fingerprint = $$", patch.payloadFingerprint);
    if (patch.callId !== undefined) push("call_id = $$", patch.callId);
    if (patch.completedAt !== undefined) {
      sets.push(`completed_at = to_timestamp($${idx} / 1000.0)`);
      params.push(patch.completedAt);
      idx += 1;
    }

    // updated_at always bumps.
    sets.push("updated_at = now()");

    // WHERE clause enforces guards. `IS NOT DISTINCT FROM` treats NULL as
    // equal, so a fresh row (lease_owner_id NULL) accepts a bootstrap
    // update from a caller passing expectedLeaseOwnerId = undefined.
    const wheres: string[] = ["operation_id = $" + idx];
    params.push(operationId);
    idx += 1;

    if (guard?.expectedPlanVersion !== undefined) {
      wheres.push(`expected_plan_version = $${idx}`);
      params.push(guard.expectedPlanVersion);
      idx += 1;
    }
    if (guard?.expectedStatus !== undefined) {
      wheres.push(`status = $${idx}`);
      params.push(guard.expectedStatus);
      idx += 1;
    }
    if (guard?.expectedLeaseOwnerId !== undefined) {
      wheres.push(`lease_owner_id IS NOT DISTINCT FROM $${idx}`);
      params.push(guard.expectedLeaseOwnerId);
      idx += 1;
    }
    if (guard?.expectedLeaseToken !== undefined) {
      wheres.push(`lease_token IS NOT DISTINCT FROM $${idx}`);
      params.push(guard.expectedLeaseToken);
      idx += 1;
    }

    const sql = `UPDATE checkout_operations SET ${sets.join(", ")}
                 WHERE ${wheres.join(" AND ")}
                 RETURNING ${SELECT_COLUMNS}`;
    const result = await queryPostgres<CheckoutOperationRow>(sql, params);
    if (!result) {
      return { ok: false, reason: "not_found" };
    }

    if (result.rows.length > 0) {
      return { ok: true, record: rowToRecord(result.rows[0]!) };
    }

    // Guard failed — reload to classify.
    const currentResult = await queryPostgres<CheckoutOperationRow>(
      `SELECT ${SELECT_COLUMNS} FROM checkout_operations WHERE operation_id = $1 LIMIT 1`,
      [operationId],
    );
    const currentRow = currentResult?.rows?.[0];
    if (!currentRow) return { ok: false, reason: "not_found" };

    const current = rowToRecord(currentRow);
    if (
      guard?.expectedPlanVersion !== undefined &&
      guard.expectedPlanVersion !== current.expectedPlanVersion
    ) {
      return { ok: false, reason: "stale_plan", record: current };
    }
    if (
      guard?.expectedStatus !== undefined &&
      guard.expectedStatus !== current.lifecycleStatus
    ) {
      return { ok: false, reason: "stale_status", record: current };
    }
    if (
      (guard?.expectedLeaseOwnerId !== undefined &&
        guard.expectedLeaseOwnerId !== current.leaseOwnerId) ||
      (guard?.expectedLeaseToken !== undefined &&
        guard.expectedLeaseToken !== current.leaseToken)
    ) {
      return { ok: false, reason: "stale_lease", record: current };
    }
    // Fallback — no guard tripped but no row updated implies the record
    // vanished between reads.
    return { ok: false, reason: "not_found" };
  }

  async list(): Promise<CheckoutOperationRecord[]> {
    const result = await queryPostgres<CheckoutOperationRow>(
      `SELECT ${SELECT_COLUMNS} FROM checkout_operations ORDER BY created_at ASC`,
    );
    return (result?.rows ?? []).map(rowToRecord);
  }

  async clear(): Promise<void> {
    await queryPostgres(`DELETE FROM checkout_operations`);
  }
}
