-- Remove experimental call_sessions table (voice module uses call_logs only).
DROP TABLE IF EXISTS "call_sessions" CASCADE;
