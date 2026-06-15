/** Call history stored on CallerProfile.metadata.call_history */
export type CallerCallHistoryRecord = {
  first_seen_at: string;
  last_seen_at: string;
  total_calls: number;
  last_call_sid: string | null;
  last_order_number: string | null;
  last_intent: string | null;
  last_call_summary: string | null;
};

export function parseCallerCallHistory(metadata: unknown): CallerCallHistoryRecord | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).call_history;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const first_seen_at = typeof record.first_seen_at === 'string' ? record.first_seen_at : null;
  const last_seen_at = typeof record.last_seen_at === 'string' ? record.last_seen_at : null;
  if (!first_seen_at || !last_seen_at) return null;

  return {
    first_seen_at,
    last_seen_at,
    total_calls: Math.max(0, Number(record.total_calls ?? 0) || 0),
    last_call_sid: typeof record.last_call_sid === 'string' ? record.last_call_sid : null,
    last_order_number:
      typeof record.last_order_number === 'string' ? record.last_order_number : null,
    last_intent: typeof record.last_intent === 'string' ? record.last_intent : null,
    last_call_summary:
      typeof record.last_call_summary === 'string' ? record.last_call_summary : null,
  };
}

export function recordInboundCallVisit(
  existing: CallerCallHistoryRecord | null,
  args: {
    callSid: string;
    nowIso: string;
    lastOrderNumber?: string | null;
    lastIntent?: string | null;
    lastCallSummary?: string | null;
  },
): CallerCallHistoryRecord {
  const priorTotal = existing?.total_calls ?? 0;
  return {
    first_seen_at: existing?.first_seen_at ?? args.nowIso,
    last_seen_at: args.nowIso,
    total_calls: priorTotal + 1,
    last_call_sid: args.callSid,
    last_order_number: args.lastOrderNumber ?? existing?.last_order_number ?? null,
    last_intent: args.lastIntent ?? existing?.last_intent ?? null,
    last_call_summary: args.lastCallSummary ?? existing?.last_call_summary ?? null,
  };
}

export function mergeCallHistoryMetadata(
  metadata: unknown,
  history: CallerCallHistoryRecord,
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  return { ...base, call_history: history };
}
