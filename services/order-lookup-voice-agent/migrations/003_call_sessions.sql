-- Priority 5: persistent UnifiedCallSession snapshots for restart survival + HA
-- Apply: psql $DATABASE_URL -f migrations/003_call_sessions.sql

BEGIN;

CREATE TABLE IF NOT EXISTS call_sessions (
  call_sid        TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed', 'archived')),
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  session_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  from_number     TEXT,
  to_number       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_status_updated
  ON call_sessions (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_sessions_active
  ON call_sessions (call_sid)
  WHERE status = 'active';

COMMENT ON TABLE call_sessions IS
  'UnifiedCallSession snapshots — L2 persistence behind in-memory L1 cache';

COMMIT;
