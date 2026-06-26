-- Step 11: durable workflow history schema
-- Applied automatically on startup when DATABASE_URL is set.

CREATE TABLE IF NOT EXISTS call_sessions (
    id              TEXT PRIMARY KEY,
    call_sid        TEXT NOT NULL,
    phone_masked    TEXT NOT NULL DEFAULT '',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'active',
    summary         TEXT NOT NULL DEFAULT '',
    runtime_mode    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_call_sid ON call_sessions (call_sid);

CREATE TABLE IF NOT EXISTS conversation_turns (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES call_sessions (id) ON DELETE CASCADE,
    turn_id         TEXT NOT NULL DEFAULT '',
    role            TEXT NOT NULL,
    content_masked  TEXT NOT NULL DEFAULT '',
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    latency_ms      DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_session ON conversation_turns (session_id, timestamp);

CREATE TABLE IF NOT EXISTS tool_events (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES call_sessions (id) ON DELETE CASCADE,
    turn_id         TEXT NOT NULL DEFAULT '',
    tool_name       TEXT NOT NULL,
    status          TEXT NOT NULL,
    input_masked    TEXT NOT NULL DEFAULT '',
    output_masked   TEXT NOT NULL DEFAULT '',
    error_code      TEXT NOT NULL DEFAULT '',
    latency_ms      DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_events_session ON tool_events (session_id, created_at);

CREATE TABLE IF NOT EXISTS payment_links (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES call_sessions (id) ON DELETE CASCADE,
    draft_order_id  TEXT NOT NULL DEFAULT '',
    url_masked      TEXT NOT NULL DEFAULT '',
    sent_to_masked  TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'sent',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_links_session ON payment_links (session_id, created_at);

CREATE TABLE IF NOT EXISTS escalations (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES call_sessions (id) ON DELETE CASCADE,
    type            TEXT NOT NULL,
    payload_masked  TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'created',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escalations_session ON escalations (session_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_events (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES call_sessions (id) ON DELETE CASCADE,
    turn_id         TEXT NOT NULL DEFAULT '',
    event_type      TEXT NOT NULL,
    payload_masked  TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_session ON workflow_events (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_events_turn ON workflow_events (session_id, turn_id, created_at);

CREATE TABLE IF NOT EXISTS customer_profiles (
    id              BIGSERIAL PRIMARY KEY,
    phone_hash      TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL DEFAULT '',
    email_masked    TEXT NOT NULL DEFAULT '',
    last_summary    TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_phone_hash ON customer_profiles (phone_hash);
