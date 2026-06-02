/**
 * Coerce ElevenLabs / voice tool booleans from mixed payload shapes.
 * Tools often send true/false as strings ("yes", "1") which must not reach strict DTOs.
 */
export function coerceBoolean(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return undefined;
}

/** First defined boolean among keys on a flat tool-parameters object. */
export function pickBooleanFromRecord(
  obj: Record<string, unknown>,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const coerced = coerceBoolean(obj[key]);
    if (coerced !== undefined) return coerced;
  }
  return undefined;
}
