/** Human-readable message from Nest `ApiExceptionFilter` JSON or plain text bodies. */
export function parseApiErrorMessage(text: string, status: number): string {
  const trimmed = text.trim();
  if (!trimmed) return `Request failed (${status})`;
  try {
    const json = JSON.parse(trimmed) as {
      message?: string | string[];
      error?: string | { message?: string | string[] };
    };
    if (typeof json.message === 'string') return json.message;
    if (Array.isArray(json.message) && typeof json.message[0] === 'string') return json.message[0];
    if (typeof json.error === 'string') return json.error;
    if (json.error && typeof json.error === 'object') {
      const m = (json.error as { message?: string | string[] }).message;
      if (typeof m === 'string') return m;
      if (Array.isArray(m) && typeof m[0] === 'string') return m[0];
    }
  } catch {
    /* not JSON */
  }
  if (trimmed.length < 200) return trimmed;
  return `Request failed (${status})`;
}

/** Read `Response` body once and map to a user-visible message (Nest JSON or plain text). */
export async function parseApiErrorResponse(res: Response): Promise<string> {
  const text = await res.text();
  return parseApiErrorMessage(text, res.status);
}
