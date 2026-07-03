-- Phase 1: immutable call event log for replay / observability platform
-- Apply: psql $DATABASE_URL -f migrations/001_call_events.sql

BEGIN;

CREATE TABLE IF NOT EXISTS call_events (
  id              BIGSERIAL PRIMARY KEY,
  call_sid        TEXT NOT NULL,
  turn_seq        INTEGER NOT NULL CHECK (turn_seq >= 0),
  event_type      TEXT NOT NULL,
  event_version   INTEGER NOT NULL DEFAULT 1 CHECK (event_version >= 1),
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  memory_before   JSONB,
  memory_after    JSONB,
  latency_ms      INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT call_events_event_type_check CHECK (
    event_type IN (
      'TURN_INGESTED',
      'MEMORY_SYNCD',
      'TOOL_SELECTED',
      'EXECUTION_FROZEN',
      'TOOL_EXECUTION_STARTED',
      'TOOL_EXECUTION_COMPLETED',
      'VALIDATION_RESULT',
      'RESPONSE_SENT'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_call_events_sid_turn_seq
  ON call_events (call_sid, turn_seq);

CREATE INDEX IF NOT EXISTS idx_call_events_sid_created
  ON call_events (call_sid, created_at);

CREATE INDEX IF NOT EXISTS idx_call_events_type_created
  ON call_events (event_type, created_at);

COMMENT ON TABLE call_events IS 'Append-only agent lifecycle events for Stripe-like call replay';

COMMIT;
