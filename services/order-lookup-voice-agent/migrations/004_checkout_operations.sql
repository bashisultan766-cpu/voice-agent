-- Durable CheckoutOperation ledger for multi-instance safe checkout execution.
-- ActionGateway persists STARTED here BEFORE any external Shopify / Resend call.
-- Concurrent workers that share an idempotency_key converge on the same row via
-- the unique constraint; stale writers are rejected by the expected-lease and
-- expected-plan-version guards.
--
-- Apply: psql $DATABASE_URL -f migrations/004_checkout_operations.sql

BEGIN;

CREATE TABLE IF NOT EXISTS checkout_operations (
  operation_id             TEXT PRIMARY KEY,
  idempotency_key          TEXT NOT NULL,
  call_id                  TEXT,
  checkout_plan_id         TEXT NOT NULL,
  checkout_group_id        TEXT NOT NULL,
  attempt                  INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status                   TEXT NOT NULL
                             CHECK (status IN (
                               'started',
                               'draft_created',
                               'invoice_sent',
                               'invoice_unknown',
                               'failed'
                             )),
  expected_plan_version    INTEGER NOT NULL DEFAULT 0,
  lease_owner_id           TEXT,
  lease_token              TEXT,
  shopify_draft_order_id   TEXT,
  invoice_url              TEXT,
  invoice_message_id       TEXT,
  shopify_invoice_ref      TEXT,
  provider_request_id      TEXT,
  last_error_code          TEXT,
  invoice_last_error       TEXT,
  reconciliation_metadata  JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_fingerprint      TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at             TIMESTAMPTZ
);

-- Idempotency key must be globally unique — two concurrent workers must
-- collapse into a single durable operation row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_operations_idempotency_key
  ON checkout_operations (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_checkout_operations_call_id
  ON checkout_operations (call_id)
  WHERE call_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_checkout_operations_group
  ON checkout_operations (checkout_group_id);

CREATE INDEX IF NOT EXISTS idx_checkout_operations_status
  ON checkout_operations (status, updated_at DESC);

COMMENT ON TABLE checkout_operations IS
  'Durable ActionGateway ledger — one row per checkout idempotency_key. Persisted BEFORE external Shopify / Resend calls to guarantee crash-safe resume.';

COMMIT;
