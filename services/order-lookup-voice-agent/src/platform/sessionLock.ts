/**
 * Per-callSid async mutex — serializes rapid Twilio WebSocket frames so
 * UnifiedCallSession mutations + persistence cannot race within a process.
 *
 * Cross-process races are handled by optimistic versioning in sessionPersistence.
 */
const chains = new Map<string, Promise<unknown>>();

export async function withCallSessionLock<T>(
  callSid: string,
  work: () => Promise<T> | T,
): Promise<T> {
  const key = (callSid ?? "").trim();
  if (!key) return work();

  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const next = previous.then(() => gate);
  chains.set(key, next);

  await previous.catch(() => undefined);

  try {
    return await work();
  } finally {
    release();
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  }
}

/** Test / teardown helper. */
export function clearCallSessionLocks(): void {
  chains.clear();
}
