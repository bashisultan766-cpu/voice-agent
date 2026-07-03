/**
 * Postgres dual-write — non-blocking append to immutable call_events table.
 * Disabled when DATABASE_URL is unset (local tests / single-node without DB).
 */
import { logger } from "../utils/logger.js";
import type { StoredAgentEvent } from "./events.js";

let pool: import("pg").Pool | null = null;
let poolInitAttempted = false;

async function getPool(): Promise<import("pg").Pool | null> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return null;

  if (pool) return pool;
  if (poolInitAttempted) return null;

  poolInitAttempted = true;
  try {
    const pg = await import("pg");
    pool = new pg.default.Pool({
      connectionString: databaseUrl,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
    });
    return pool;
  } catch (err) {
    logger.warn("postgres_event_store_unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
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
  void appendToPostgres(event).catch((err) => {
    logger.warn("postgres_event_append_failed", {
      callSid: event.callSid.slice(0, 8),
      eventType: event.eventType,
      turnSeq: event.turnSeq,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export async function appendToPostgres(event: StoredAgentEvent): Promise<void> {
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
}
