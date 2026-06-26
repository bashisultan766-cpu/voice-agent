-- Step 12: analytics and evaluation schema

CREATE TABLE IF NOT EXISTS call_metrics (
    id                      BIGSERIAL PRIMARY KEY,
    session_id              TEXT NOT NULL UNIQUE REFERENCES call_sessions (id) ON DELETE CASCADE,
    call_sid                TEXT NOT NULL DEFAULT '',
    duration_seconds        DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_turns             INTEGER NOT NULL DEFAULT 0,
    successful_tools        INTEGER NOT NULL DEFAULT 0,
    failed_tools            INTEGER NOT NULL DEFAULT 0,
    avg_turn_latency_ms     DOUBLE PRECISION NOT NULL DEFAULT 0,
    max_turn_latency_ms     DOUBLE PRECISION NOT NULL DEFAULT 0,
    payment_link_sent       BOOLEAN NOT NULL DEFAULT FALSE,
    escalation_created      BOOLEAN NOT NULL DEFAULT FALSE,
    order_lookup_count      INTEGER NOT NULL DEFAULT 0,
    refund_lookup_count     INTEGER NOT NULL DEFAULT 0,
    product_search_count    INTEGER NOT NULL DEFAULT 0,
    facility_query_count    INTEGER NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_metrics_created ON call_metrics (created_at);
CREATE INDEX IF NOT EXISTS idx_call_metrics_call_sid ON call_metrics (call_sid);

CREATE TABLE IF NOT EXISTS agent_evaluations (
    id                      BIGSERIAL PRIMARY KEY,
    session_id              TEXT NOT NULL UNIQUE REFERENCES call_sessions (id) ON DELETE CASCADE,
    intent_success_score    DOUBLE PRECISION NOT NULL DEFAULT 0,
    tool_selection_score    DOUBLE PRECISION NOT NULL DEFAULT 0,
    response_quality_score  DOUBLE PRECISION NOT NULL DEFAULT 0,
    safety_score            DOUBLE PRECISION NOT NULL DEFAULT 0,
    latency_score           DOUBLE PRECISION NOT NULL DEFAULT 0,
    overall_score           DOUBLE PRECISION NOT NULL DEFAULT 0,
    issues_json             TEXT NOT NULL DEFAULT '[]',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_evaluations_created ON agent_evaluations (created_at);
CREATE INDEX IF NOT EXISTS idx_agent_evaluations_overall ON agent_evaluations (overall_score);
