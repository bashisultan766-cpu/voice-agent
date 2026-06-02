import { pickString } from './normalize-send-payment-link-body.util';

/** ElevenLabs ConvAI server tool POST body (flat or wrapped). */
export type ElevenLabsToolRequestBody = Record<string, unknown>;

/**
 * ElevenLabs may POST `{ parameters: { email, variantId, ... }, conversation_id, tool_call_id }`.
 * Flatten to a single object for validation and field extraction.
 */
export function flattenElevenLabsToolBody(body: ElevenLabsToolRequestBody): ElevenLabsToolRequestBody {
  if (!body || typeof body !== 'object') return {};

  const params = body.parameters;
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    return {
      ...(params as Record<string, unknown>),
      conversation_id: body.conversation_id,
      tool_call_id: body.tool_call_id,
      tool_name: body.tool_name,
    };
  }

  return body;
}

export function resolveCallSidFromToolBody(body: ElevenLabsToolRequestBody): string | undefined {
  const flat = flattenElevenLabsToolBody(body);
  return (
    pickString(flat, [
      'callSid',
      'call_sid',
      'CallSid',
      'twilio_call_sid',
      'system__call_sid',
      'system_call_sid',
    ]) ?? pickString(body, ['callSid', 'call_sid', 'CallSid', 'system__call_sid'])
  );
}

export function resolvePhoneNumberFromToolBody(body: ElevenLabsToolRequestBody): string | undefined {
  const flat = flattenElevenLabsToolBody(body);
  return (
    pickString(flat, [
      'phoneNumber',
      'phone',
      'phone_number',
      'caller_phone',
      'caller_number',
      'from_number',
      'system__caller_id',
      'system_caller_id',
    ]) ??
    pickString(body, ['phoneNumber', 'phone', 'caller_phone', 'system__caller_id'])
  );
}

function pickBoolean(obj: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    if (typeof v === 'string') {
      const normalized = v.trim().toLowerCase();
      // Normalize common tool payload booleans from string forms.
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
      if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    }
  }
  return undefined;
}

export function resolveSendPaymentLinkFieldsFromToolBody(body: ElevenLabsToolRequestBody): {
  email?: string;
  variantId?: string;
  quantity?: number;
  phoneNumber?: string;
  callSid?: string;
  tenantId?: string;
  agentId?: string;
  emailConfirmed?: boolean;
} {
  const flat = flattenElevenLabsToolBody(body);

  const quantityRaw = flat.quantity;
  let quantity: number | undefined;
  if (typeof quantityRaw === 'number' && Number.isFinite(quantityRaw)) {
    quantity = Math.trunc(quantityRaw);
  } else if (typeof quantityRaw === 'string' && quantityRaw.trim()) {
    const n = Number(quantityRaw);
    if (Number.isFinite(n)) quantity = Math.trunc(n);
  }

  return {
    email: pickString(flat, ['email']),
    variantId: pickString(flat, ['variantId', 'variant_id']),
    quantity,
    phoneNumber: resolvePhoneNumberFromToolBody(body),
    callSid: resolveCallSidFromToolBody(body),
    tenantId: pickString(flat, ['tenantId', 'tenant_id']),
    agentId: pickString(flat, ['agentId', 'agent_id']),
    // Accept common payload typos emitted by voice tools ("emailComfirmed").
    emailConfirmed: pickBoolean(flat, [
      'emailConfirmed',
      'email_confirmed',
      'emailComfirmed',
      'email_comfirmed',
    ]),
  };
}
