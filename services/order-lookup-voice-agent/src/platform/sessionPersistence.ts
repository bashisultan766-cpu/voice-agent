/**
 * UnifiedCallSession L2 persistence — Postgres JSONB snapshots.
 *
 * Architecture:
 *   L1 = in-process Map (unifiedCallSession registry) — microsecond hot path
 *   L2 = call_sessions table — restart survival + horizontal scale
 *
 * Atomic strategy:
 *   1. withCallSessionLock(callSid) serializes mutations inside one Node process
 *   2. Optimistic version column: UPDATE … WHERE version = $expected
 *      On conflict, reload + retry (bounded) so two instances cannot clobber state
 *
 * When DATABASE_URL / Postgres is unavailable, all ops no-op and L1-only mode
 * preserves existing test + local-dev behavior.
 */
import type { CallSession } from "../types/order.js";
import { logger } from "../utils/logger.js";
import {
  isPostgresDisabled,
  isPostgresEventStoreEnabled,
  queryPostgres,
} from "./postgresEventStore.js";
import {
  assertSessionSafeForPersistence,
  serializeSessionForPersistence,
} from "./sessionSerialization.js";

export type PersistedSessionStatus = "active" | "completed" | "archived";

export interface PersistedSessionRecord {
  callSid: string;
  status: PersistedSessionStatus;
  version: number;
  session: CallSession;
}

const MAX_OPTIMISTIC_RETRIES = 3;

let persistenceEnabled = false;
let schemaReady = false;
let schemaInitAttempted = false;

export function isSessionPersistenceEnabled(): boolean {
  return persistenceEnabled && isPostgresEventStoreEnabled() && !isPostgresDisabled();
}

/** Called after initPostgresEventStore — enables dual-write when DB is healthy. */
export async function initSessionPersistence(): Promise<boolean> {
  if (!isPostgresEventStoreEnabled() || isPostgresDisabled()) {
    persistenceEnabled = false;
    logger.info("session_persistence_disabled", { reason: "postgres_unavailable" });
    return false;
  }

  const ready = await ensureCallSessionsSchema();
  persistenceEnabled = ready;
  if (ready) {
    logger.info("session_persistence_ready");
  }
  return ready;
}

async function ensureCallSessionsSchema(): Promise<boolean> {
  if (schemaReady) return true;
  if (schemaInitAttempted && !schemaReady) return false;
  schemaInitAttempted = true;

  try {
    await queryPostgres(`
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
      )
    `);
    await queryPostgres(`
      CREATE INDEX IF NOT EXISTS idx_call_sessions_status_updated
        ON call_sessions (status, updated_at DESC)
    `);
    schemaReady = true;
    return true;
  } catch (err) {
    schemaReady = false;
    logger.warn("session_persistence_schema_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function cloneSession(session: CallSession): CallSession {
  return JSON.parse(JSON.stringify(session)) as CallSession;
}

function readVersion(session: CallSession): number {
  return typeof session.persistenceVersion === "number" && session.persistenceVersion >= 1
    ? session.persistenceVersion
    : 1;
}

function writeVersion(session: CallSession, version: number): void {
  session.persistenceVersion = version;
}

/** Load active session snapshot from Postgres (null when miss / disabled). */
export async function loadPersistedSession(
  callSid: string,
): Promise<PersistedSessionRecord | null> {
  if (!isSessionPersistenceEnabled()) return null;

  try {
    const result = await queryPostgres<{
      call_sid: string;
      status: PersistedSessionStatus;
      version: number;
      session_json: CallSession | string;
    }>(
      `SELECT call_sid, status, version, session_json
       FROM call_sessions
       WHERE call_sid = $1 AND status = 'active'
       LIMIT 1`,
      [callSid],
    );
    const row = result?.rows?.[0];
    if (!row) return null;

    const session =
      typeof row.session_json === "string"
        ? (JSON.parse(row.session_json) as CallSession)
        : row.session_json;
    if (!session || typeof session !== "object") return null;

    session.callSid = row.call_sid;
    writeVersion(session, row.version);
    return {
      callSid: row.call_sid,
      status: row.status,
      version: row.version,
      session,
    };
  } catch (err) {
    logger.warn("session_persistence_load_failed", {
      callSid: callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export type SessionPersistResult =
  | { ok: true; version: number | null; skipped?: boolean }
  | { ok: false; reason: "optimistic_exhausted" | "save_failed" };

/**
 * Upsert active session with optimistic concurrency.
 * Caller MUST hold withCallSessionLock(callSid) — do not fire this from hot mid-turn paths.
 * Returns the new version, or null when persistence is disabled.
 */
export async function savePersistedSession(session: CallSession): Promise<number | null> {
  const result = await savePersistedSessionDetailed(session);
  if (result.ok) return result.version;
  return null;
}

/** Same as savePersistedSession but surfaces exhaustion vs hard failure for the LLM brain. */
export async function savePersistedSessionDetailed(
  session: CallSession,
): Promise<SessionPersistResult> {
  if (!isSessionPersistenceEnabled()) {
    return { ok: true, version: null, skipped: true };
  }

  try {
    assertSessionSafeForPersistence(session);
  } catch (err) {
    logger.warn("session_persistence_privacy_guard_tripped", {
      callSid: session.callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "save_failed" };
  }

  let expected = readVersion(session);
  for (let attempt = 0; attempt < MAX_OPTIMISTIC_RETRIES; attempt += 1) {
    const payload = cloneSession(session);
    writeVersion(payload, expected);
    const nextVersion = expected + 1;

    try {
      const serialized = serializeSessionForPersistence(payload);
      const result = await queryPostgres(
        `INSERT INTO call_sessions (
           call_sid, status, version, session_json, from_number, to_number, updated_at
         ) VALUES ($1, 'active', $2, $3::jsonb, $4, $5, now())
         ON CONFLICT (call_sid) DO UPDATE SET
           status = 'active',
           version = EXCLUDED.version,
           session_json = EXCLUDED.session_json,
           from_number = EXCLUDED.from_number,
           to_number = EXCLUDED.to_number,
           updated_at = now(),
           completed_at = NULL
         WHERE call_sessions.version = $6
            OR call_sessions.status <> 'active'`,
        [
          session.callSid,
          nextVersion,
          serialized,
          session.from ?? null,
          session.to ?? null,
          expected,
        ],
      );

      const rowCount = result?.rowCount ?? 0;
      if (rowCount > 0) {
        writeVersion(session, nextVersion);
        return { ok: true, version: nextVersion };
      }

      // Version conflict — reload and retry with latest version.
      const latest = await loadPersistedSession(session.callSid);
      expected = latest?.version ?? expected + 1;
      logger.info("session_persistence_optimistic_retry", {
        callSid: session.callSid.slice(0, 8),
        attempt: attempt + 1,
        expected,
      });
    } catch (err) {
      logger.warn("session_persistence_save_failed", {
        callSid: session.callSid.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason: "save_failed" };
    }
  }

  logger.warn("session_persistence_optimistic_exhausted", {
    callSid: session.callSid.slice(0, 8),
  });
  return { ok: false, reason: "optimistic_exhausted" };
}

/**
 * @deprecated Mid-turn fire-and-forget persists caused optimistic_exhausted under load.
 * Prefer touchUnifiedSession (L1 only) + flushUnifiedSessionToL2 (locked) at turn/tool boundaries.
 * This is intentionally a no-op so legacy call sites cannot fan out concurrent L2 writers.
 */
export function persistSessionAsync(_session: CallSession): void {
  // no-op — see flushUnifiedSessionToL2
}

/** Mark session completed/archived so it cannot be hydrated as live. */
export async function archivePersistedSession(
  callSid: string,
  session?: CallSession,
): Promise<void> {
  if (!isSessionPersistenceEnabled()) return;

  try {
    if (session) assertSessionSafeForPersistence(session);
    const payload = session
      ? serializeSessionForPersistence(cloneSession(session))
      : null;
    if (payload) {
      await queryPostgres(
        `INSERT INTO call_sessions (
           call_sid, status, version, session_json, from_number, to_number, updated_at, completed_at
         ) VALUES ($1, 'completed', 1, $2::jsonb, $3, $4, now(), now())
         ON CONFLICT (call_sid) DO UPDATE SET
           status = 'completed',
           session_json = COALESCE(EXCLUDED.session_json, call_sessions.session_json),
           updated_at = now(),
           completed_at = now()`,
        [callSid, payload, session?.from ?? null, session?.to ?? null],
      );
    } else {
      await queryPostgres(
        `UPDATE call_sessions
         SET status = 'completed', updated_at = now(), completed_at = now()
         WHERE call_sid = $1`,
        [callSid],
      );
    }
  } catch (err) {
    logger.warn("session_persistence_archive_failed", {
      callSid: callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function archivePersistedSessionAsync(
  callSid: string,
  session?: CallSession,
): void {
  if (!isSessionPersistenceEnabled()) return;
  void archivePersistedSession(callSid, session).catch(() => undefined);
}

/** Test hook. */
export function resetSessionPersistenceState(): void {
  persistenceEnabled = false;
  schemaReady = false;
  schemaInitAttempted = false;
}
