export const GENERIC_FIRST_MESSAGE =
  'Thank you for calling SureShot Books. This is Eric. How can I help you today?';

export type ReturningCallerLookupResult = {
  callerRecognized: boolean;
  customerId: string | null;
  customerFirstName: string | null;
  customerFullName: string | null;
  totalPreviousCalls: number;
  lastOrderNumber: string | null;
  lastCallSummary: string | null;
  callerPhoneVerified: 'none' | 'partial';
};

export type ElevenLabsConversationInitiation = {
  dynamicVariables: Record<string, string>;
  firstMessage: string;
  personalized: boolean;
};

/** Strip email/address-like fragments from summaries before sending to the agent. */
export function sanitizeLastCallSummary(summary: string | null | undefined): string {
  if (!summary?.trim()) return '';
  return summary
    .replace(/\b[\w.+-]+@[\w.-]+\.\w{2,}\b/gi, '[email]')
    .replace(/\b\d{3,5}\s+\w+(\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln))\b/gi, '[address]')
    .replace(/\b\d{13,19}\b/g, '[card]')
    .trim()
    .slice(0, 240);
}

export function buildPersonalizedFirstMessage(firstName: string): string {
  const name = firstName.trim();
  return `Hi ${name}, welcome back to SureShot Books. How can I help you today?`;
}

export function hasUsableFirstName(firstName: string | null | undefined): firstName is string {
  const trimmed = firstName?.trim();
  if (!trimmed) return false;
  if (/^(unknown|caller|guest|n\/a)$/i.test(trimmed)) return false;
  return trimmed.length >= 2;
}

/**
 * Build ElevenLabs conversation_initiation_client_data fields.
 * Phone match allows first-name greeting only — never full email, address, or card data.
 */
export function buildConversationInitiation(
  lookup: ReturningCallerLookupResult,
): ElevenLabsConversationInitiation {
  if (!lookup.callerRecognized) {
    return {
      personalized: false,
      firstMessage: GENERIC_FIRST_MESSAGE,
      dynamicVariables: {
        caller_recognized: 'false',
        caller_phone_verified: 'none',
      },
    };
  }

  const safeSummary = sanitizeLastCallSummary(lookup.lastCallSummary);
  const dynamicVariables: Record<string, string> = {
    caller_recognized: 'true',
    caller_phone_verified: lookup.callerPhoneVerified,
    customer_id: lookup.customerId ?? '',
    customer_full_name: lookup.customerFullName?.trim() || '',
    total_previous_calls: String(Math.max(0, lookup.totalPreviousCalls)),
    last_order_number: lookup.lastOrderNumber?.trim() || '',
    last_call_summary: safeSummary,
  };

  if (hasUsableFirstName(lookup.customerFirstName)) {
    dynamicVariables.customer_first_name = lookup.customerFirstName.trim();
    return {
      personalized: true,
      firstMessage: buildPersonalizedFirstMessage(lookup.customerFirstName),
      dynamicVariables,
    };
  }

  return {
    personalized: false,
    firstMessage: GENERIC_FIRST_MESSAGE,
    dynamicVariables: {
      ...dynamicVariables,
      customer_first_name: '',
    },
  };
}

export function maskPhoneForLog(raw: string, normalized: string): { rawMasked: string; normalizedMasked: string } {
  const mask = (value: string) => {
    const digits = value.replace(/\D/g, '');
    if (digits.length <= 4) return '****';
    return `***${digits.slice(-4)}`;
  };
  return { rawMasked: mask(raw), normalizedMasked: mask(normalized) };
}

/** Ensure no sensitive PII is passed to ElevenLabs dynamic variables. */
export function assertNoSensitiveDynamicVariables(vars: Record<string, string>): void {
  const blockedPatterns = [
    /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/i,
    /\b\d{13,19}\b/,
    /\b\d{3}-\d{2}-\d{4}\b/,
  ];
  for (const [key, value] of Object.entries(vars)) {
    if (!value) continue;
    for (const pattern of blockedPatterns) {
      if (pattern.test(value)) {
        throw new Error(`Sensitive value blocked from ElevenLabs dynamic variable: ${key}`);
      }
    }
  }
}
