import { Injectable, Logger } from '@nestjs/common';

export type CallDiagnosticEvent = {
  event: string;
  at: string;
  details?: Record<string, string | number | boolean | null>;
};

export type CallDiagnosticSnapshot = {
  call_sid: string;
  call_started_at: string | null;
  call_ended_at: string | null;
  call_duration_seconds: number | null;
  twilio_call_sid: string | null;
  twilio_call_status: string | null;
  elevenlabs_conversation_id: string | null;
  elevenlabs_disconnect_reason: string | null;
  websocket_close_code: number | null;
  websocket_close_reason: string | null;
  tool_timeouts: number;
  tool_failures: number;
  customer_reported_call_cutoff: boolean;
  events: CallDiagnosticEvent[];
};

type CallRecord = {
  callSid: string;
  startedAt: number;
  endedAt: number | null;
  twilioCallStatus: string | null;
  elevenlabsConversationId: string | null;
  elevenlabsDisconnectReason: string | null;
  websocketCloseCode: number | null;
  websocketCloseReason: string | null;
  toolTimeouts: number;
  toolFailures: number;
  customerReportedCutoff: boolean;
  events: CallDiagnosticEvent[];
};

const TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class VoiceCallDiagnosticsService {
  private readonly logger = new Logger(VoiceCallDiagnosticsService.name);
  private readonly store = new Map<string, CallRecord>();

  recordCallStarted(args: {
    callSid: string;
    twilioCallStatus?: string;
    callerPhoneMasked?: string;
  }): void {
    const now = Date.now();
    const record = this.getOrCreate(args.callSid);
    record.startedAt = record.startedAt || now;
    record.twilioCallStatus = args.twilioCallStatus ?? record.twilioCallStatus;
    this.pushEvent(args.callSid, 'call_started', {
      twilio_call_status: args.twilioCallStatus ?? null,
      caller_phone_masked: args.callerPhoneMasked ?? null,
    });
    this.logger.log(
      JSON.stringify({
        event: 'call_started',
        callSid: args.callSid,
        twilioCallStatus: args.twilioCallStatus ?? null,
      }),
    );
    this.prune();
  }

  recordCallEnded(args: {
    callSid: string;
    twilioCallStatus?: string;
    elevenlabsDisconnectReason?: string;
    websocketCloseCode?: number;
    websocketCloseReason?: string;
  }): void {
    const record = this.getOrCreate(args.callSid);
    record.endedAt = Date.now();
    record.twilioCallStatus = args.twilioCallStatus ?? record.twilioCallStatus;
    record.elevenlabsDisconnectReason =
      args.elevenlabsDisconnectReason ?? record.elevenlabsDisconnectReason;
    record.websocketCloseCode = args.websocketCloseCode ?? record.websocketCloseCode;
    record.websocketCloseReason = args.websocketCloseReason ?? record.websocketCloseReason;
    this.pushEvent(args.callSid, 'call_ended', {
      twilio_call_status: args.twilioCallStatus ?? null,
      elevenlabs_disconnect_reason: args.elevenlabsDisconnectReason ?? null,
      websocket_close_code: args.websocketCloseCode ?? null,
    });
    const durationSec =
      record.startedAt && record.endedAt
        ? Math.round((record.endedAt - record.startedAt) / 1000)
        : null;
    this.logger.log(
      JSON.stringify({
        event: 'call_ended',
        callSid: args.callSid,
        call_duration_seconds: durationSec,
        twilio_call_status: args.twilioCallStatus ?? null,
      }),
    );
  }

  recordElevenLabsConversation(callSid: string, conversationId: string): void {
    const record = this.getOrCreate(callSid);
    record.elevenlabsConversationId = conversationId;
    this.pushEvent(callSid, 'elevenlabs_conversation_linked', {
      elevenlabs_conversation_id: conversationId,
    });
  }

  recordToolTimeout(callSid: string | undefined, toolName: string): void {
    if (!callSid) return;
    const record = this.getOrCreate(callSid);
    record.toolTimeouts += 1;
    this.pushEvent(callSid, 'tool_timeout', { tool: toolName });
    this.logger.warn(
      JSON.stringify({ event: 'tool_timeout', callSid, tool: toolName }),
    );
  }

  recordToolFailure(callSid: string | undefined, toolName: string, message: string): void {
    if (!callSid) return;
    const record = this.getOrCreate(callSid);
    record.toolFailures += 1;
    this.pushEvent(callSid, 'tool_failed', {
      tool: toolName,
      message: message.slice(0, 200),
    });
    this.logger.warn(
      JSON.stringify({
        event: 'tool_failed',
        callSid,
        tool: toolName,
        message: message.slice(0, 200),
      }),
    );
  }

  recordCustomerReportedCutoff(callSid: string): void {
    const record = this.getOrCreate(callSid);
    record.customerReportedCutoff = true;
    this.pushEvent(callSid, 'customer_reported_call_cutoff', {});
    this.logger.log(
      JSON.stringify({ event: 'customer_reported_call_cutoff', callSid }),
    );
  }

  getDiagnostics(callSid: string): CallDiagnosticSnapshot | null {
    const record = this.store.get(callSid);
    if (!record) return null;

    const durationSec =
      record.startedAt && record.endedAt
        ? Math.round((record.endedAt - record.startedAt) / 1000)
        : record.startedAt
          ? Math.round((Date.now() - record.startedAt) / 1000)
          : null;

    return {
      call_sid: record.callSid,
      call_started_at: record.startedAt ? new Date(record.startedAt).toISOString() : null,
      call_ended_at: record.endedAt ? new Date(record.endedAt).toISOString() : null,
      call_duration_seconds: durationSec,
      twilio_call_sid: record.callSid,
      twilio_call_status: record.twilioCallStatus,
      elevenlabs_conversation_id: record.elevenlabsConversationId,
      elevenlabs_disconnect_reason: record.elevenlabsDisconnectReason,
      websocket_close_code: record.websocketCloseCode,
      websocket_close_reason: record.websocketCloseReason,
      tool_timeouts: record.toolTimeouts,
      tool_failures: record.toolFailures,
      customer_reported_call_cutoff: record.customerReportedCutoff,
      events: [...record.events],
    };
  }

  private getOrCreate(callSid: string): CallRecord {
    let record = this.store.get(callSid);
    if (!record) {
      record = {
        callSid,
        startedAt: 0,
        endedAt: null,
        twilioCallStatus: null,
        elevenlabsConversationId: null,
        elevenlabsDisconnectReason: null,
        websocketCloseCode: null,
        websocketCloseReason: null,
        toolTimeouts: 0,
        toolFailures: 0,
        customerReportedCutoff: false,
        events: [],
      };
      this.store.set(callSid, record);
    }
    return record;
  }

  private pushEvent(
    callSid: string,
    event: string,
    details?: Record<string, string | number | boolean | null>,
  ): void {
    const record = this.getOrCreate(callSid);
    record.events.push({ event, at: new Date().toISOString(), details });
    if (record.events.length > 50) record.events.shift();
  }

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [sid, record] of this.store.entries()) {
      const last = record.endedAt ?? record.startedAt;
      if (last && last < cutoff) this.store.delete(sid);
    }
  }
}
