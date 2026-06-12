import type {
  ThreeCxCallHistoryRecord,
  ThreeCxContactRecord,
  ThreeCxRecordingRecord,
} from '../three-cx-api.client';

export type CallerInfoCallHistoryItem = {
  call_id: string;
  direction: string | null;
  started_at: string | null;
  duration_seconds: number | null;
  answered: boolean | null;
  recording_url: string | null;
};

export type CallerInfoPurchaseItem = {
  title: string;
  quantity: number;
  price: string | null;
  purchased_at: string | null;
};

export type GetCallerInfoResponse = {
  success: true;
  phone_number: string;
  exists: boolean;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company: string | null;
  contact_id: string | null;
  is_returning_caller: boolean;
  call_count: number;
  last_call_date: string | null;
  call_history: CallerInfoCallHistoryItem[];
  recording_urls: string[];
  past_purchases: CallerInfoPurchaseItem[];
  total_past_orders: number;
  last_purchase_date: string | null;
  greeting_hint: string;
  source: 'three_cx_api' | 'local_cache' | 'mixed' | 'none';
  three_cx_configured: boolean;
  should_ask_for_name: boolean;
};

export function buildGetCallerInfoResponse(args: {
  phoneNumber: string;
  threeCxConfigured: boolean;
  contact: ThreeCxContactRecord | null;
  callHistory: ThreeCxCallHistoryRecord[];
  recordings: ThreeCxRecordingRecord[];
  recordingUrls: string[];
  localPriorCallCount?: number;
  localDisplayName?: string | null;
  pastPurchases?: CallerInfoPurchaseItem[];
  totalPastOrders?: number;
  lastPurchaseDate?: string | null;
  source: GetCallerInfoResponse['source'];
}): GetCallerInfoResponse {
  const fullName =
    args.contact?.displayName?.trim() ||
    args.localDisplayName?.trim() ||
    [args.contact?.firstName, args.contact?.lastName].filter(Boolean).join(' ').trim() ||
    null;

  const firstName = args.contact?.firstName?.trim() || splitFirst(fullName);
  const lastName = args.contact?.lastName?.trim() || splitLast(fullName);
  const exists = Boolean(fullName || args.contact?.id);

  const callCount = Math.max(args.callHistory.length, args.localPriorCallCount ?? 0);
  const lastCallDate = pickLatestIsoDate([
    ...args.callHistory.map((row) => row.startedAt),
    ...args.recordings.map((row) => row.startedAt),
  ]);

  const pastPurchases = args.pastPurchases ?? [];
  const isReturningCaller = callCount > 0 || pastPurchases.length > 0;

  const callHistory: CallerInfoCallHistoryItem[] = args.callHistory.map((row, index) => ({
    call_id: row.segmentId || `history-${index + 1}`,
    direction: row.direction,
    started_at: row.startedAt,
    duration_seconds: row.durationSeconds,
    answered: row.answered,
    recording_url:
      row.recordingId && args.recordingUrls.length > 0
        ? args.recordingUrls.find((url) => url.includes(row.recordingId!)) ?? null
        : null,
  }));

  return {
    success: true,
    phone_number: args.phoneNumber,
    exists,
    full_name: fullName,
    first_name: firstName,
    last_name: lastName,
    email: args.contact?.email ?? null,
    company: args.contact?.company ?? null,
    contact_id: args.contact?.id || null,
    is_returning_caller: isReturningCaller,
    call_count: callCount,
    last_call_date: lastCallDate,
    call_history: callHistory,
    recording_urls: args.recordingUrls,
    past_purchases: pastPurchases,
    total_past_orders: args.totalPastOrders ?? 0,
    last_purchase_date: args.lastPurchaseDate ?? null,
    greeting_hint: buildGreetingHint({
      firstName,
      fullName,
      isReturningCaller,
      callCount,
      lastCallDate,
      pastPurchases,
    }),
    source: args.source,
    three_cx_configured: args.threeCxConfigured,
    should_ask_for_name: !firstName && !fullName,
  };
}

function buildGreetingHint(args: {
  firstName: string | null;
  fullName: string | null;
  isReturningCaller: boolean;
  callCount: number;
  lastCallDate: string | null;
  pastPurchases: CallerInfoPurchaseItem[];
}): string {
  const purchaseNote =
    args.pastPurchases.length > 0
      ? ` They previously bought: ${args.pastPurchases
          .slice(0, 3)
          .map((item) => item.title)
          .join(', ')}. Reference it naturally (e.g. "last time you ordered ...").`
      : '';

  if (args.firstName && args.isReturningCaller) {
    const when = args.lastCallDate ? ` Their last call was ${formatFriendlyDate(args.lastCallDate)}.` : '';
    return `Greet ${args.firstName} by first name and mention they have called ${args.callCount} time(s) before.${when}${purchaseNote}`;
  }
  if (args.firstName) {
    return `Greet ${args.firstName} by first name. This may be their first call on record.${purchaseNote}`;
  }
  if (args.isReturningCaller) {
    return `This phone number has called before, but no name is on file. Ask for their name once, then save it.${purchaseNote}`;
  }
  return 'Unknown caller. Ask for their name once, then save it with SaveCallerName.';
}

function pickLatestIsoDate(values: Array<string | null | undefined>): string | null {
  const parsed = values
    .map((value) => (value ? new Date(value) : null))
    .filter((date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  return parsed[0]?.toISOString() ?? null;
}

function formatFriendlyDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function splitFirst(displayName: string | null): string | null {
  if (!displayName) return null;
  return displayName.trim().split(/\s+/)[0] ?? null;
}

function splitLast(displayName: string | null): string | null {
  if (!displayName) return null;
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(1).join(' ');
}
