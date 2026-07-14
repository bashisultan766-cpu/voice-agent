/**
 * Production bootstrap for the durable CheckoutOperationRepository.
 *
 * Rules (non-negotiable):
 *   - production (NODE_ENV=production or DEPLOYMENT_ENV=production) MUST use
 *     Postgres. If DATABASE_URL is unset, Postgres is unreachable, or the
 *     `checkout_operations` table is missing, we throw a fatal error — there
 *     is no silent memory fallback.
 *   - `REQUIRE_DURABLE_CHECKOUT_OPS=true` or `CHECKOUT_OPS_REPO=postgres`
 *     force the same durable path in any environment.
 *   - `NODE_ENV=test` / `VITEST=true` keep the in-memory repository unless
 *     `CHECKOUT_OPS_REPO=postgres` explicitly asks for Postgres.
 *   - Everywhere else (development without DATABASE_URL) we log a warning and
 *     allow the in-memory repository — but never in production.
 */
import { logger } from "../utils/logger.js";
import {
  setDefaultCheckoutOperationRepository,
  resetDefaultCheckoutOperationRepository,
} from "../domain/checkoutOperation.js";
import {
  initPostgresEventStore,
  isPostgresEventStoreEnabled,
  queryPostgres,
} from "./postgresEventStore.js";
import { PostgresCheckoutOperationRepository } from "./postgresCheckoutOperationRepository.js";

export interface CheckoutOperationBootstrapResult {
  mode: "postgres" | "memory";
  reason?: string;
}

function boolFlag(value: string | undefined): boolean {
  if (!value) return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function isProductionRuntime(): boolean {
  const nodeEnv = process.env.NODE_ENV?.trim();
  const deployEnv = process.env.DEPLOYMENT_ENV?.trim();
  return nodeEnv === "production" || deployEnv === "production";
}

export function isTestRuntime(): boolean {
  const nodeEnv = process.env.NODE_ENV?.trim();
  return nodeEnv === "test" || boolFlag(process.env.VITEST);
}

export function isDurableCheckoutOpsRequired(): boolean {
  if (isProductionRuntime()) return true;
  if (boolFlag(process.env.REQUIRE_DURABLE_CHECKOUT_OPS)) return true;
  if ((process.env.CHECKOUT_OPS_REPO ?? "").toLowerCase() === "postgres") return true;
  return false;
}

async function ensureCheckoutOperationsTable(): Promise<boolean> {
  const result = await queryPostgres<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_name = 'checkout_operations'
     ) AS exists`,
  );
  return result?.rows?.[0]?.exists === true;
}

/**
 * Initialise the default CheckoutOperationRepository. In production this
 * MUST succeed — a durable Postgres-backed repository is a hard requirement
 * for multi-instance commerce reliability.
 *
 * Callers upstream (index.ts bootstrap) must fail startup if this throws.
 */
export async function initCheckoutOperationRepository(): Promise<CheckoutOperationBootstrapResult> {
  const durableRequired = isDurableCheckoutOpsRequired();
  const forcePostgres = (process.env.CHECKOUT_OPS_REPO ?? "").toLowerCase() === "postgres";
  const testRuntime = isTestRuntime();
  const productionRuntime = isProductionRuntime();

  // In tests we default to memory unless the caller explicitly opted into
  // Postgres for the durable integration battery.
  if (testRuntime && !forcePostgres) {
    resetDefaultCheckoutOperationRepository();
    logger.info("checkout_operation_repository_memory", {
      reason: "test_runtime",
    });
    return { mode: "memory", reason: "test_runtime" };
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (durableRequired) {
    if (!databaseUrl) {
      const message =
        "checkout_operation_repository_fatal: DATABASE_URL is required for durable checkout operations (production or REQUIRE_DURABLE_CHECKOUT_OPS)";
      logger.error(message, { productionRuntime, forcePostgres });
      throw new Error(message);
    }

    const pgReady = await initPostgresEventStore();
    if (!pgReady || !isPostgresEventStoreEnabled()) {
      const message =
        "checkout_operation_repository_fatal: Postgres unreachable — refusing to boot with in-memory checkout operations";
      logger.error(message, { productionRuntime, forcePostgres });
      throw new Error(message);
    }

    const tableReady = await ensureCheckoutOperationsTable();
    if (!tableReady) {
      const message =
        "checkout_operation_repository_fatal: checkout_operations table missing — run migrations/004_checkout_operations.sql before starting";
      logger.error(message, { productionRuntime, forcePostgres });
      throw new Error(message);
    }

    setDefaultCheckoutOperationRepository(new PostgresCheckoutOperationRepository());
    logger.info("checkout_operation_repository_postgres_ready", {
      productionRuntime,
      forcePostgres,
    });
    return { mode: "postgres" };
  }

  // Development / staging with DATABASE_URL: prefer Postgres if the schema is
  // ready, but fall back to memory with a loud warning so operators know they
  // are not multi-instance safe.
  if (databaseUrl) {
    const pgReady = await initPostgresEventStore();
    if (pgReady && isPostgresEventStoreEnabled()) {
      const tableReady = await ensureCheckoutOperationsTable();
      if (tableReady) {
        setDefaultCheckoutOperationRepository(new PostgresCheckoutOperationRepository());
        logger.info("checkout_operation_repository_postgres_ready", {
          productionRuntime: false,
          forcePostgres: false,
        });
        return { mode: "postgres" };
      }
      logger.warn("checkout_operation_repository_memory", {
        reason: "checkout_operations_table_missing",
      });
      resetDefaultCheckoutOperationRepository();
      return { mode: "memory", reason: "table_missing" };
    }
  }

  logger.warn("checkout_operation_repository_memory", {
    reason: "no_database_url_or_postgres_unavailable",
    productionRuntime: false,
  });
  resetDefaultCheckoutOperationRepository();
  return { mode: "memory", reason: "no_database_url_or_postgres_unavailable" };
}
