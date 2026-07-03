/**
 * Hard caller firewall — Shopify/order tools may only run from conversationOrchestrator.
 */
const AUTHORIZED_CALLER = "conversationOrchestrator";

let activeCaller: string | null = null;
let testBypassEnabled = false;

export function runWithToolAuthorization<T>(caller: string, fn: () => T): T {
  const previous = activeCaller;
  activeCaller = caller;
  try {
    return fn();
  } finally {
    activeCaller = previous;
  }
}

export async function runWithToolAuthorizationAsync<T>(
  caller: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = activeCaller;
  activeCaller = caller;
  try {
    return await fn();
  } finally {
    activeCaller = previous;
  }
}

export function assertToolAccessAuthorized(tool: string): void {
  if (testBypassEnabled) return;
  if (activeCaller !== AUTHORIZED_CALLER) {
    throw new Error(`TOOL ACCESS VIOLATION: ${tool}`);
  }
}

/** Enable/disable caller bypass for isolated tool unit tests. */
export function enableToolAccessForTests(enabled = true): void {
  testBypassEnabled = enabled;
}

export function resetToolAccessGuard(): void {
  testBypassEnabled = false;
  activeCaller = null;
}
