-- Rollback for migrations/004_checkout_operations.sql
-- Apply manually: psql $DATABASE_URL -f migrations/004_checkout_operations.down.sql
--
-- scripts/runMigrations.ts intentionally skips *.down.sql files; rollbacks are a
-- manual operator step so a failed forward migration cannot be silently reverted.

BEGIN;

DROP INDEX IF EXISTS idx_checkout_operations_status;
DROP INDEX IF EXISTS idx_checkout_operations_group;
DROP INDEX IF EXISTS idx_checkout_operations_call_id;
DROP INDEX IF EXISTS uq_checkout_operations_idempotency_key;
DROP TABLE IF EXISTS checkout_operations;

COMMIT;
