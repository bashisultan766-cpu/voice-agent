import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const REGISTER_CALL_URL = 'https://api.elevenlabs.io/v1/convai/twilio/register-call';
const DEFAULT_CONVAI_AGENT_ID = 'agent_2401kswaf3cpegs890qs6jjcb00v';

export type ElevenLabsTwilioRegisterCallInput = {
  fromNumber: string;
  toNumber: string;
  direction?: 'inbound' | 'outbound';
  callSid?: string;
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
    const body = {
      agent_id: agentId,
      from_number: input.fromNumber,
      to_number: input.toNumber,
      direction: input.direction ?? 'inbound',
    };

    const started = Date.now();
    this.logger.log(
      JSON.stringify({
        event: 'elevenlabs.twilio.register_call_started',
        agentId,
        direction: body.direction,
        callSid: input.callSid ?? null,
        fromMasked: maskPhone(input.fromNumber),
        toMasked: maskPhone(input.toNumber),
      }),
    );

    const res = await fetch(REGISTER_CALL_URL, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey(),
        'Content-Type': 'application/json',
        Accept: 'text/xml, application/xml, text/html, application/json',
      },
      body: JSON.stringify(body),
    });

    const raw = (await res.text()).trim();
    const latencyMs = Date.now() - started;

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
