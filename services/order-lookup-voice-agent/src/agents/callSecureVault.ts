/**
 * Call-scoped secure vault — holds shipping / history that must NOT appear in
 * LLM prompts or L2 session JSON until the caller passes verification (phone
 * match or zip/street challenge).
 *
 * Non-serializable: toJSON throws so accidental persistence/logging fails closed.
 */
export interface SecureOrderVaultEntry {
  orderNumber: string;
  shippingAddress?: string;
  pastOrderHistory?: unknown;
  orderNote?: string;
  customAttributes?: Array<{ key: string; value: string }>;
  storedAt: number;
}

const vaultByCallSid = new Map<string, SecureOrderVaultEntry>();

const vaultProxy = {
  toJSON(): never {
    throw new Error("SecureOrderVault must never be serialized");
  },
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[SecureOrderVault]";
  },
};

export function storeSecureOrderVault(
  callSid: string,
  entry: Omit<SecureOrderVaultEntry, "storedAt">,
): void {
  const sid = (callSid ?? "").trim();
  if (!sid) return;
  const value: SecureOrderVaultEntry = Object.assign(Object.create(vaultProxy), {
    ...entry,
    storedAt: Date.now(),
  });
  vaultByCallSid.set(sid, value);
}

export function getSecureOrderVault(callSid: string): SecureOrderVaultEntry | undefined {
  const sid = (callSid ?? "").trim();
  if (!sid) return undefined;
  return vaultByCallSid.get(sid);
}

export function clearSecureOrderVault(callSid: string): void {
  const sid = (callSid ?? "").trim();
  if (!sid) return;
  vaultByCallSid.delete(sid);
}

export const CallSecureVault = {
  store: storeSecureOrderVault,
  get: getSecureOrderVault,
  clear: clearSecureOrderVault,
} as const;
