/**
 * Postgres dual-write — non-blocking append to immutable call_events table.
 *
 * Startup probe sets postgresEnabled once. If unreachable, POSTGRES_DISABLED is set
 * for the process lifetime and all appends return immediately (no per-turn spam).
 */
import { logger } from "../utils/logger.js";
import type { StoredAgentEvent } from "./events.js";

let pool: import("pg").Pool | null = null;
let poolInitAttempted = false;
let postgresEnabled = false;
let postgresFatalLogged = false;

/** Permanent process-wide silencer after failed startup probe or fatal append error. */
let POSTGRES_DISABLED = false;

export function isPostgresEventStoreEnabled(): boolean {
  return postgresEnabled && !POSTGRES_DISABLED;
}

export function isPostgresDisabled(): boolean {
  return POSTGRES_DISABLED;
}

/**
 * Verify DATABASE_URL and connectivity at startup.
 * Returns true only when dual-write is safe to use for this process lifetime.
 */
export async function initPostgresEventStore(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    POSTGRES_DISABLED = true;
    postgresEnabled = false;
    logger.info("postgres_event_store_disabled", { reason: "DATABASE_URL unset" });
    return false;
  }

  if (postgresEnabled && pool && !POSTGRES_DISABLED) return true;

  try {
    const db = await createPool(databaseUrl);
    await db.query("SELECT 1");
    POSTGRES_DISABLED = false;
    postgresEnabled = true;
    logger.info("postgres_event_store_ready");
    return true;
  } catch (err) {
    POSTGRES_DISABLED = true;
    postgresEnabled = false;
    if (pool) {
      await pool.end().catch(() => undefined);
      pool = null;
      poolInitAttempted = false;
    }
    if (!postgresFatalLogged) {
      postgresFatalLogged = true;
      logger.error("postgres_event_store_fatal", {
        message:
          "Postgres unreachable at startup — dual-write disabled; using in-memory event store only",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }
}

async function createPool(databaseUrl: string): Promise<import("pg").Pool> {
  if (pool) return pool;
  if (poolInitAttempted && !pool) {
    throw new Error("postgres_pool_unavailable");
  }

  poolInitAttempted = true;
  const pg = await import("pg");
  pool = new pg.default.Pool({
    connectionString: databaseUrl,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });
  return pool;
}

async function getPool(): Promise<import("pg").Pool | null> {
  if (POSTGRES_DISABLED || !postgresEnabled) return null;

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return null;

  try {
    return await createPool(databaseUrl);
  } catch (err) {
    disablePostgresAfterFailure(err);
    return null;
  }
}

function disablePostgresAfterFailure(err: unknown): void {
  POSTGRES_DISABLED = true;
  postgresEnabled = false;
  if (!postgresFatalLogged) {
    postgresFatalLogged = true;
    logger.error("postgres_event_store_fatal", {
      message: "Postgres dual-write disabled after connection failure",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const INSERT_SQL = `
  INSERT INTO call_events (
    call_sid,
    turn_seq,
    event_type,
    event_version,
    payload,
    memory_before,
    memory_after,
    latency_ms,
    created_at
  ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, to_timestamp($9 / 1000.0))
`;

/** Fire-and-forget — never blocks voice path on DB I/O. */
export function appendToPostgresAsync(event: StoredAgentEvent): void {
  if (POSTGRES_DISABLED || !postgresEnabled) return;

  void appendToPostgres(event).catch((err) => {
    disablePostgresAfterFailure(err);
  });
}

export async function appendToPostgres(event: StoredAgentEvent): Promise<void> {
  if (POSTGRES_DISABLED || !postgresEnabled) return;

  const db = await getPool();
  if (!db) return;

  await db.query(INSERT_SQL, [
    event.callSid,
    event.turnSeq,
    event.eventType,
    event.eventVersion,
    JSON.stringify(event.payload),
    event.memoryBefore ? JSON.stringify(event.memoryBefore) : null,
    event.memoryAfter ? JSON.stringify(event.memoryAfter) : null,
    event.latencyMs,
    event.createdAt,
  ]);
}

export async function closePostgresPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    poolInitAttempted = false;
  }
  POSTGRES_DISABLED = true;
  postgresEnabled = false;
}

/** Test hook — reset module state between tests. */
export function resetPostgresEventStoreState(): void {
  POSTGRES_DISABLED = false;
  postgresEnabled = false;
  postgresFatalLogged = false;
  poolInitAttempted = false;
}
