-- Production: remove legacy experimental call_sessions (not defined in schema.prisma).
-- The voice module uses call_logs only. Idempotent on fresh and upgraded databases.
DROP TABLE IF EXISTS "call_sessions" CASCADE;
