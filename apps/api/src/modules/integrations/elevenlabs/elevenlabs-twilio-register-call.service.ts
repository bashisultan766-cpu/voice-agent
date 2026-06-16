import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { normalizePhoneNumber } from '../twilio/utils/normalize-phone';

import {

  assertNoSensitiveDynamicVariables,

  GENERIC_FIRST_MESSAGE,

  type ElevenLabsConversationInitiation,

} from './utils/returning-caller-personalization.util';



const REGISTER_CALL_URL = 'https://api.elevenlabs.io/v1/convai/twilio/register-call';

const DEFAULT_CONVAI_AGENT_ID = 'agent_2401kswaf3cpegs890qs6jjcb00v';



/** @deprecated Legacy 3CX fields — prefer ReturningCaller initiation payload. */

export type ElevenLabsCallerDynamicVariables = {

  callerName?: string | null;

  callerFirstName?: string | null;

  isReturningCaller?: boolean;

  priorCallCount?: number;

  callCount?: number;

  lastCallDate?: string | null;

  recordingUrlsJson?: string;

  greetingHint?: string;

  pastPurchases?: string;

};



export type ElevenLabsTwilioRegisterCallInput = {

  fromNumber: string;

  toNumber: string;

  direction?: 'inbound' | 'outbound';

  callSid?: string;

  phoneNormalized?: string;

  initiation?: ElevenLabsConversationInitiation;

  /** @deprecated Use initiation instead. */

  callerIdentity?: ElevenLabsCallerDynamicVariables;

};



@Injectable()

export class ElevenLabsTwilioRegisterCallService {

  private readonly logger = new Logger(ElevenLabsTwilioRegisterCallService.name);



  constructor(private readonly config: ConfigService) {}



  resolveAgentId(): string {

    return (

      this.config.get<string>('ELEVENLABS_CONVAI_AGENT_ID')?.trim() ||

      process.env.ELEVENLABS_CONVAI_AGENT_ID?.trim() ||

      DEFAULT_CONVAI_AGENT_ID

    );

  }

  /** Optional — route register-call to a published agent branch (agtbrch_...). */
  resolveBranchId(): string | null {
    const branchId =
      this.config.get<string>('ELEVENLABS_CONVAI_BRANCH_ID')?.trim() ||
      process.env.ELEVENLABS_CONVAI_BRANCH_ID?.trim() ||
      '';
    return branchId || null;
  }

  /**
   * When true, register-call sends only agent_id + phone numbers (legacy/simple mode).
   * Use to test if dynamic_variables, branch_id, or first_message override break the bridge.
   */
  isMinimalRegisterCallMode(): boolean {
    return (
      this.config.get<string>('ELEVENLABS_MINIMAL_REGISTER_CALL')?.trim() === 'true' ||
      process.env.ELEVENLABS_MINIMAL_REGISTER_CALL?.trim() === 'true'
    );
  }



  private apiKey(): string {

    const key =

      this.config.get<string>('ELEVENLABS_API_KEY')?.trim() ||

      process.env.ELEVENLABS_API_KEY?.trim();

    if (!key) {

      throw new Error('ELEVENLABS_API_KEY is not configured.');

    }

    return key;

  }



  /**

   * Registers an inbound Twilio call with ElevenLabs and returns TwiML for Twilio.

   */

  async registerInboundCall(input: ElevenLabsTwilioRegisterCallInput): Promise<string> {

    const agentId = this.resolveAgentId();

    const callerPhone =

      input.phoneNormalized?.trim() ||

      normalizePhoneNumber(input.fromNumber) ||

      input.fromNumber.trim();



    const body: Record<string, unknown> = {

      agent_id: agentId,

      from_number: input.fromNumber,

      to_number: input.toNumber,

      direction: input.direction ?? 'inbound',

    };



    if (input.callSid?.trim() && !this.isMinimalRegisterCallMode()) {

      const initiation: ElevenLabsConversationInitiation =

        input.initiation ?? {

          personalized: false,

          firstMessage: GENERIC_FIRST_MESSAGE,

          dynamicVariables: {

            caller_recognized: 'false',

            caller_phone_verified: 'none',

          },

        };

      const dynamicVariables: Record<string, string> = {

        call_sid: input.callSid.trim(),

        caller_phone: callerPhone,

        caller_number: input.fromNumber.trim(),

        twilio_to_number: input.toNumber.trim(),

        ...initiation.dynamicVariables,

      };



      assertNoSensitiveDynamicVariables(dynamicVariables);



      const conversationInitiation: Record<string, unknown> = {

        dynamic_variables: dynamicVariables,

      };



      if (initiation.firstMessage) {
        const skipOverride =
          this.config.get<string>('ELEVENLABS_SKIP_FIRST_MESSAGE_OVERRIDE')?.trim() === 'true' ||
          process.env.ELEVENLABS_SKIP_FIRST_MESSAGE_OVERRIDE?.trim() === 'true';

        if (!skipOverride) {
          conversationInitiation.conversation_config_override = {
            agent: {
              first_message: initiation.firstMessage,
            },
          };
        } else {
          this.logger.warn(
            JSON.stringify({
              event: 'elevenlabs_first_message_override_skipped',
              callSid: input.callSid,
              reason: 'ELEVENLABS_SKIP_FIRST_MESSAGE_OVERRIDE=true',
            }),
          );
        }
      }

      const branchId = this.resolveBranchId();
      if (branchId) {
        conversationInitiation.branch_id = branchId;
      }

      body.conversation_initiation_client_data = conversationInitiation;

      this.logger.log(
        JSON.stringify({
          event: initiation.personalized
            ? 'returning_caller_first_message_applied'
            : 'generic_first_message_applied',
          callSid: input.callSid,
          firstMessagePreview: initiation.firstMessage?.slice(0, 80) ?? null,
          callerRecognized: dynamicVariables.caller_recognized ?? null,
          branchId: branchId ?? null,
        }),
      );

    } else if (this.isMinimalRegisterCallMode()) {
      this.logger.warn(
        JSON.stringify({
          event: 'elevenlabs_minimal_register_call_mode',
          callSid: input.callSid ?? null,
          reason: 'ELEVENLABS_MINIMAL_REGISTER_CALL=true — no dynamic_variables or branch_id',
        }),
      );
    }

    const started = Date.now();

    this.logger.log(
      JSON.stringify({
        event: 'elevenlabs_register_call_started',
        agentId,
        branchId: this.resolveBranchId(),
        minimalRegisterCall: this.isMinimalRegisterCallMode(),
        direction: body.direction,
        callSid: input.callSid ?? null,
        dynamicVariablesAttached: Boolean(input.callSid?.trim()),
        fromMasked: maskPhone(input.fromNumber),
        toMasked: maskPhone(input.toNumber),
      }),
    );



    const requestInit: RequestInit = {

      method: 'POST',

      headers: {

        'xi-api-key': this.apiKey(),

        'Content-Type': 'application/json',

        Accept: 'text/xml, application/xml, text/html, application/json',

      },

      body: JSON.stringify(body),

      signal: AbortSignal.timeout(10_000),

    };



    let res: Response | null = null;

    let raw = '';

    let lastNetworkError: unknown;

    const maxAttempts = 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {

      try {

        res = await fetch(REGISTER_CALL_URL, requestInit);

        raw = (await res.text()).trim();

        break;

      } catch (err) {

        lastNetworkError = err;

        if (attempt < maxAttempts - 1) {

          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));

        }

      }

    }



    const latencyMs = Date.now() - started;

    if (!res) {

      const networkMessage = formatFetchError(lastNetworkError);

      this.logger.error(

        JSON.stringify({

          event: 'elevenlabs_register_call_failed',

          reason: 'network',

          latencyMs,

          attempts: maxAttempts,

          message: networkMessage.slice(0, 500),

          callSid: input.callSid ?? null,

        }),

      );

      throw new Error(networkMessage);

    }



    if (!res.ok) {

      this.logger.error(

        JSON.stringify({

          event: 'elevenlabs_register_call_failed',

          status: res.status,

          latencyMs,

          bodyPreview: raw.slice(0, 400),

        }),

      );

      throw new Error(`ElevenLabs register-call returned ${res.status}: ${raw.slice(0, 200)}`);

    }



    const twiml = extractTwiML(raw);

    if (!twiml.includes('<Response')) {

      this.logger.error(

        JSON.stringify({

          event: 'elevenlabs_register_call_failed',

          reason: 'invalid_twiml',

          latencyMs,

          bodyPreview: raw.slice(0, 400),

        }),

      );

      throw new Error('ElevenLabs register-call response did not contain TwiML.');

    }



    this.logger.log(
      JSON.stringify({
        event: 'elevenlabs_register_call_success',
        status: res.status,
        latencyMs,
        twimlBytes: twiml.length,
        twimlHasConnect: /<Connect/i.test(twiml),
        twimlHasConversation: /Conversation/i.test(twiml),
        agentId,
        callSid: input.callSid ?? null,
      }),
    );



    return twiml;

  }

}



function buildLegacyDynamicVariables(

  input: ElevenLabsTwilioRegisterCallInput,

  callerPhone: string,

): Record<string, string> {

  const identity = input.callerIdentity;

  if (!identity) {

    return {

      caller_recognized: 'false',

      caller_phone_verified: 'none',

    };

  }

  return {

    caller_name: identity.callerName?.trim() || '',

    caller_first_name: identity.callerFirstName?.trim() || '',

    is_returning_caller: identity.isReturningCaller ? 'true' : 'false',

    prior_call_count: String(identity.priorCallCount ?? 0),

    call_count: String(identity.callCount ?? identity.priorCallCount ?? 0),

    last_call_date: identity.lastCallDate?.trim() || '',

    recording_urls_json: identity.recordingUrlsJson?.trim() || '[]',

    greeting_hint: identity.greetingHint?.trim() || '',

    past_purchases: identity.pastPurchases?.trim() || '',

    caller_phone: callerPhone,

    caller_recognized: identity.isReturningCaller ? 'true' : 'false',

    caller_phone_verified: identity.isReturningCaller ? 'partial' : 'none',

  };

}



function formatFetchError(err: unknown): string {

  if (!(err instanceof Error)) return String(err);

  const cause = (err as Error & { cause?: unknown }).cause;

  const causeCode =

    cause && typeof cause === 'object' && 'code' in cause

      ? String((cause as { code?: string }).code ?? '')

      : '';

  const parts = [err.message];

  if (causeCode) parts.push(`code=${causeCode}`);

  if (cause instanceof Error && cause.message && cause.message !== err.message) {

    parts.push(cause.message);

  }

  return parts.join(' | ');

}



function maskPhone(value: string): string {

  const digits = value.replace(/\D/g, '');

  if (digits.length <= 4) return '****';

  return `***${digits.slice(-4)}`;

}



/** ElevenLabs may return raw TwiML or JSON wrapping twiml. */

export function extractTwiML(raw: string): string {

  const trimmed = raw.trim();

  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<Response')) {

    return trimmed;

  }

  try {

    const parsed = JSON.parse(trimmed) as { twiml?: string; TwiML?: string };

    const fromJson = parsed.twiml ?? parsed.TwiML;

    if (typeof fromJson === 'string' && fromJson.trim()) {

      return fromJson.trim();

    }

  } catch {

    // not JSON — use raw body

  }

  return trimmed;

}



/** @internal Exported for unit tests — builds register-call JSON body. */

export function buildRegisterCallRequestBody(

  input: ElevenLabsTwilioRegisterCallInput,

): Record<string, unknown> {

  const callerPhone =

    input.phoneNormalized?.trim() ||

    normalizePhoneNumber(input.fromNumber) ||

    input.fromNumber.trim();



  const body: Record<string, unknown> = {

    agent_id: 'agent_test',

    from_number: input.fromNumber,

    to_number: input.toNumber,

    direction: input.direction ?? 'inbound',

  };



  if (!input.callSid?.trim() || !input.initiation) return body;



  const dynamicVariables: Record<string, string> = {

    call_sid: input.callSid.trim(),

    caller_phone: callerPhone,

    caller_number: input.fromNumber.trim(),

    twilio_to_number: input.toNumber.trim(),

    ...input.initiation.dynamicVariables,

  };

  assertNoSensitiveDynamicVariables(dynamicVariables);



  body.conversation_initiation_client_data = {

    dynamic_variables: dynamicVariables,

    conversation_config_override: {

      agent: { first_message: input.initiation.firstMessage },

    },

  };



  return body;

}


