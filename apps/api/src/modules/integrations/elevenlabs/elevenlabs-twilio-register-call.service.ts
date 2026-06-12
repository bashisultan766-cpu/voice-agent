import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizePhoneNumber } from '../twilio/utils/normalize-phone';

const REGISTER_CALL_URL = 'https://api.elevenlabs.io/v1/convai/twilio/register-call';
const DEFAULT_CONVAI_AGENT_ID = 'agent_2401kswaf3cpegs890qs6jjcb00v';

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
    const callerPhone = normalizePhoneNumber(input.fromNumber) || input.fromNumber.trim();
    const body: Record<string, unknown> = {
      agent_id: agentId,
      from_number: input.fromNumber,
      to_number: input.toNumber,
      direction: input.direction ?? 'inbound',
    };

    if (input.callSid?.trim()) {
      const identity = input.callerIdentity;
      const dynamicVariables: Record<string, string> = {
        call_sid: input.callSid.trim(),
        caller_phone: callerPhone,
        caller_number: input.fromNumber.trim(),
        twilio_to_number: input.toNumber.trim(),
        caller_name: identity?.callerName?.trim() || '',
        caller_first_name: identity?.callerFirstName?.trim() || '',
        is_returning_caller: identity?.isReturningCaller ? 'true' : 'false',
        prior_call_count: String(identity?.priorCallCount ?? 0),
        call_count: String(identity?.callCount ?? identity?.priorCallCount ?? 0),
        last_call_date: identity?.lastCallDate?.trim() || '',
        recording_urls_json: identity?.recordingUrlsJson?.trim() || '[]',
        greeting_hint: identity?.greetingHint?.trim() || '',
        past_purchases: identity?.pastPurchases?.trim() || '',
      };

      body.conversation_initiation_client_data = {
        dynamic_variables: dynamicVariables,
      };
    }

    const started = Date.now();
    this.logger.log(
      JSON.stringify({
        event: 'elevenlabs.twilio.register_call_started',
        agentId,
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
      signal: AbortSignal.timeout(25_000),
    };

    let res: Response | null = null;
    let raw = '';
    let lastNetworkError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(REGISTER_CALL_URL, requestInit);
        raw = (await res.text()).trim();
        break;
      } catch (err) {
        lastNetworkError = err;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
    }

    const latencyMs = Date.now() - started;
    if (!res) {
      const networkMessage = formatFetchError(lastNetworkError);
      this.logger.error(
        JSON.stringify({
          event: 'elevenlabs.twilio.register_call_network_failed',
          latencyMs,
          attempts: 3,
          message: networkMessage.slice(0, 500),
          callSid: input.callSid ?? null,
        }),
      );
      throw new Error(networkMessage);
    }

    if (!res.ok) {
      this.logger.error(
        JSON.stringify({
          event: 'elevenlabs.twilio.register_call_failed',
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
          event: 'elevenlabs.twilio.register_call_invalid_twiml',
          latencyMs,
          bodyPreview: raw.slice(0, 400),
        }),
      );
      throw new Error('ElevenLabs register-call response did not contain TwiML.');
    }

    this.logger.log(
      JSON.stringify({
        event: 'elevenlabs.twilio.register_call_success',
        status: res.status,
        latencyMs,
        twimlBytes: twiml.length,
        callSid: input.callSid ?? null,
      }),
    );

    return twiml;
  }
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
