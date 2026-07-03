/**
 * Shopify API circuit breaker — prevents throttle death-loops on live voice calls.
 *
 * State machine:
 *   CLOSED  → normal traffic
 *   OPEN    → all Shopify calls short-circuit (emit DEGRADED_MODE, no instant retry)
 *   HALF_OPEN → single probe allowed after backoff elapses
 *
 * OPEN is triggered immediately on THROTTLED. Backoff doubles per consecutive open cycle
 * (exponential, capped) so we never hammer Shopify while the bucket refills.
 */
import { logger } from "../utils/logger.js";
import {
  isShopifyThrottleError,
  ShopifyCircuitOpenError,
  ShopifyThrottledError,
} from "./shopifyErrors.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  failureCount: number;
  openedAt: number | null;
  retryAfterMs: number;
  openCycle: number;
}

const DEFAULT_BASE_OPEN_MS = 5_000;
const DEFAULT_MAX_OPEN_MS = 60_000;

let state: CircuitState = "CLOSED";
let failureCount = 0;
let openedAt: number | null = null;
let openDurationMs = DEFAULT_BASE_OPEN_MS;
let openCycle = 0;
let halfOpenProbeInFlight = false;

export function getShopifyCircuitSnapshot(): CircuitBreakerSnapshot {
  const now = Date.now();
  const remaining =
    state === "OPEN" && openedAt !== null
      ? Math.max(0, openDurationMs - (now - openedAt))
      : 0;

  return {
    state,
    failureCount,
    openedAt,
    retryAfterMs: remaining,
    openCycle,
  };
}

export function isShopifyCircuitOpen(): boolean {
  return getShopifyCircuitSnapshot().state === "OPEN";
}

export function isShopifyDegraded(): boolean {
  const snap = getShopifyCircuitSnapshot();
  return snap.state === "OPEN" || snap.state === "HALF_OPEN";
}

function transitionToOpen(reason: string): void {
  openCycle += 1;
  failureCount += 1;
  state = "OPEN";
  openedAt = Date.now();
  openDurationMs = Math.min(
    DEFAULT_BASE_OPEN_MS * 2 ** (openCycle - 1),
    DEFAULT_MAX_OPEN_MS,
  );

  logger.warn("shopify_circuit_opened", {
    reason,
    openCycle,
    openDurationMs,
    failureCount,
  });
}

function transitionToHalfOpen(): void {
  state = "HALF_OPEN";
  halfOpenProbeInFlight = false;
  logger.info("shopify_circuit_half_open", { openCycle });
}

function transitionToClosed(): void {
  state = "CLOSED";
  failureCount = 0;
  openedAt = null;
  openDurationMs = DEFAULT_BASE_OPEN_MS;
  openCycle = 0;
  halfOpenProbeInFlight = false;
  logger.info("shopify_circuit_closed");
}

/** Record successful Shopify call — resets breaker when probing or closed. */
export function recordShopifyCircuitSuccess(): void {
  if (state === "HALF_OPEN" || state === "CLOSED") {
    transitionToClosed();
  }
}

/** Record THROTTLED — circuit opens immediately with exponential backoff. */
export function recordShopifyThrottle(err?: unknown): void {
  const message =
    err instanceof ShopifyThrottledError
      ? err.message
      : err instanceof Error
        ? err.message
        : "THROTTLED";

  transitionToOpen(message);
}

/**
 * Guard Shopify work behind the circuit breaker.
 * Throws ShopifyCircuitOpenError when OPEN (no API call made).
 */
export async function withShopifyCircuitBreaker<T>(
  callSid: string,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const snap = getShopifyCircuitSnapshot();

  if (snap.state === "OPEN") {
    const elapsed = openedAt !== null ? now - openedAt : 0;
    if (elapsed < openDurationMs) {
      throw new ShopifyCircuitOpenError(openDurationMs - elapsed);
    }
    transitionToHalfOpen();
  }

  if (state === "HALF_OPEN") {
    if (halfOpenProbeInFlight) {
      throw new ShopifyCircuitOpenError(openDurationMs);
    }
    halfOpenProbeInFlight = true;
  }

  try {
    const result = await work();
    recordShopifyCircuitSuccess();
    return result;
  } catch (err) {
    if (isShopifyThrottleError(err)) {
      recordShopifyThrottle(err);
      logger.warn("shopify_throttled_call", {
        callSid: callSid.slice(0, 8),
        operation,
        circuit: getShopifyCircuitSnapshot(),
      });
    }
    throw err;
  } finally {
    if (state === "HALF_OPEN") {
      halfOpenProbeInFlight = false;
    }
  }
}

/** Test / call teardown — reset global breaker state. */
export function resetShopifyCircuitBreaker(): void {
  state = "CLOSED";
  failureCount = 0;
  openedAt = null;
  openDurationMs = DEFAULT_BASE_OPEN_MS;
  openCycle = 0;
  halfOpenProbeInFlight = false;
}
