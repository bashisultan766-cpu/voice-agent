const SECRET_KEY_PATTERN =
  /(token|secret|password|authorization|api[-_]?key|access[-_]?key|private[-_]?key|bearer|credential|secrets?enc|encrypt(ed)?|ciphertext|iv|auth(tag)?|hmac)/i;
const PII_KEY_PATTERN =
  /(email|phone|mobile|from|to|customer|recipient|name|speechresult|speech|transcript|body|address|ssn)/i;

function mask(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

/** Redact secrets and obvious PII from objects before logging. */
export function redactSecrets<T>(input: T): T {
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return input;

  if (Array.isArray(input)) {
    return input.map((item) => redactSecrets(item)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      if (typeof value === 'string') out[key] = mask(value);
      else out[key] = value == null ? value : '***';
      continue;
    }
    if (PII_KEY_PATTERN.test(key)) {
      if (typeof value === 'string') out[key] = mask(value);
      else out[key] = value == null ? value : '***';
      continue;
    }

    if (typeof value === 'object' && value !== null) {
      out[key] = redactSecrets(value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Safe one-line log for HTTP errors (no raw headers). */
export function safeRequestMeta(method: string, path: string): Record<string, string> {
  return { method, path: path.split('?')[0]?.slice(0, 200) ?? '' };
}
