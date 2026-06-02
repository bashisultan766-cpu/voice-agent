import { coerceBoolean, pickBooleanFromRecord } from '../../../common/utils/coerce-boolean.util';
import { flattenElevenLabsToolBody } from './parse-elevenlabs-tool-body.util';

const EMAIL_CONFIRMED_KEYS = [
  'emailConfirmed',
  'email_confirmed',
  'emailComfirmed',
  'email_comfirmed',
  'confirmed',
  'email_verified',
  'customer_email_confirmed',
];

/**
 * Resolve emailConfirmed for SendPaymentLink.
 * ElevenLabs ConvAI often omits boolean tool params; when callSid is present we infer confirmed
 * unless the tool explicitly sent false.
 */
export function resolvePaymentEmailConfirmed(input: {
  fromTool?: boolean;
  body: Record<string, unknown>;
  callSid?: string;
}): boolean {
  const flat = flattenElevenLabsToolBody(input.body);
  const explicit =
    input.fromTool ??
    pickBooleanFromRecord(flat, EMAIL_CONFIRMED_KEYS) ??
    pickBooleanFromRecord(input.body, EMAIL_CONFIRMED_KEYS) ??
    coerceBoolean(input.body.emailConfirmed);

  if (explicit === true) return true;
  if (explicit === false) return false;

  // On live Twilio calls, the agent already collected verbal confirmation before invoking the tool.
  return Boolean(input.callSid?.trim());
}
