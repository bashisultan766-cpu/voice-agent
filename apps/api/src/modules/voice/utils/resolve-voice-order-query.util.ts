import { normalizeVoiceOrderNumber } from './normalize-voice-order-number.util';

function pickOrderNumber(input: object): string | undefined {
  const record = input as Record<string, unknown>;
  const keys = [
    'order_number',
    'orderNumber',
    'order',
    'name',
    'order_name',
    'orderName',
    'query',
    'number',
  ];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function resolveVoiceOrderQuery(input: object): string | undefined {
  const raw = pickOrderNumber(input);
  if (!raw) return undefined;
  const normalized = normalizeVoiceOrderNumber(raw);
  return normalized || raw;
}
