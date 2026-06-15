import { Injectable, Logger } from '@nestjs/common';
import {
  buildLikelyDisconnectReason,
  inferLikelyFailureStage,
  maskPhoneForCallDiagnostics,
  QUICK_DISCONNECT_THRESHOLD_SECONDS,
  TERMINAL_TWILIO_CALL_STATUSES,
  type LikelyFailureStage,
} from '../utils/voice-call-diagnostics.util';

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
  twilio_final_status: string | null;
  twilio_error_code: string | null;
  twilio_error_message: string | null;
  elevenlabs_register_call_status: number | null;
  elevenlabs_register_call_success: boolean | null;
  twiml_sent: boolean;
  twiml_sent_at: string | null;
  twiml_bytes: number | null;
  likely_failure_stage: LikelyFailureStage | null;
  likely_reason: string | null;
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
  twilioFinalStatus: string | null;
  twilioErrorCode: string | null;
  twilioErrorMessage: string | null;
  twilioCallDurationSeconds: number | null;
  twilioFromMasked: string | null;
  twilioToMasked: string | null;
  twilioDirection: string | null;
  elevenlabsRegisterCallStatus: number | null;
  elevenlabsRegisterCallSuccess: boolean | null;
  twimlSentAt: number | null;
  twimlBytes: number | null;
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
    toPhoneMasked?: string;
    direction?: string;
  }): void {
    const now = Date.now();
    const record = this.getOrCreate(args.callSid);
    record.startedAt = record.startedAt || now;
    record.twilioCallStatus = args.twilioCallStatus ?? record.twilioCallStatus;
    if (args.callerPhoneMasked) record.twilioFromMasked = args.callerPhoneMasked;
    if (args.toPhoneMasked) record.twilioToMasked = args.toPhoneMasked;
    if (args.direction) record.twilioDirection = args.direction;
    this.pushEvent(args.callSid, 'call_started', {
      twilio_call_status: args.twilioCallStatus ?? null,
      from_masked: args.callerPhoneMasked ?? null,
      to_masked: args.toPhoneMasked ?? null,
      direction: args.direction ?? null,
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

  recordRegisterCallResult(args: {
    callSid: string;
    success: boolean;
    httpStatus?: number;
    latencyMs?: number;
    errorMessage?: string;
    twimlBytes?: number;
  }): void {
    const record = this.getOrCreate(args.callSid);
    record.elevenlabsRegisterCallSuccess = args.success;
    record.elevenlabsRegisterCallStatus = args.httpStatus ?? (args.success ? 200 : null);
    if (args.twimlBytes != null) record.twimlBytes = args.twimlBytes;

    this.pushEvent(args.callSid, args.success ? 'register_call_success' : 'register_call_failed', {
      http_status: args.httpStatus ?? null,
      latency_ms: args.latencyMs ?? null,
      twiml_bytes: args.twimlBytes ?? null,
      error_message: args.errorMessage?.slice(0, 200) ?? null,
    });

    if (!args.success) {
      this.logger.error(
        JSON.stringify({
          event: 'call_failed',
          callSid: args.callSid,
          stage: 'register_call_failed',
          httpStatus: args.httpStatus ?? null,
          message: args.errorMessage?.slice(0, 300) ?? null,
        }),
      );
    }
  }

  recordTwimlSent(args: {
    callSid: string;
    twimlBytes: number;
    personalizedGreeting?: boolean;
    callerRecognized?: boolean;
    totalElapsedMs?: number;
  }): void {
    const record = this.getOrCreate(args.callSid);
    record.twimlSentAt = Date.now();
    record.twimlBytes = args.twimlBytes;
    this.pushEvent(args.callSid, 'twiml_sent', {
      twiml_bytes: args.twimlBytes,
      personalized_greeting: args.personalizedGreeting ?? false,
      caller_recognized: args.callerRecognized ?? false,
      total_elapsed_ms: args.totalElapsedMs ?? null,
    });
    this.logger.log(
      JSON.stringify({
        event: 'twiml_sent',
        callSid: args.callSid,
        twimlBytes: args.twimlBytes,
        totalElapsedMs: args.totalElapsedMs ?? null,
      }),
    );
  }

  recordTwilioStatusCallback(args: {
    callSid: string;
    callStatus: string;
    callDuration?: string;
    direction?: string;
    from?: string;
    to?: string;
    errorCode?: string;
    errorMessage?: string;
    timestamp?: string;
  }): void {
    const record = this.getOrCreate(args.callSid);
    const normalizedStatus = args.callStatus.trim().toLowerCase();
    record.twilioCallStatus = normalizedStatus;
    record.twilioFinalStatus = normalizedStatus;
    if (args.direction) record.twilioDirection = args.direction;
    if (args.from) record.twilioFromMasked = maskPhoneForCallDiagnostics(args.from);
    if (args.to) record.twilioToMasked = maskPhoneForCallDiagnostics(args.to);
    if (args.errorCode?.trim()) record.twilioErrorCode = args.errorCode.trim();
    if (args.errorMessage?.trim()) record.twilioErrorMessage = args.errorMessage.trim().slice(0, 300);

    const parsedDuration = args.callDuration ? Number.parseInt(args.callDuration, 10) : NaN;
    if (Number.isFinite(parsedDuration)) {
      record.twilioCallDurationSeconds = parsedDuration;
    }

    if (TERMINAL_TWILIO_CALL_STATUSES.has(normalizedStatus)) {
      record.endedAt = Date.now();
    }

    this.pushEvent(args.callSid, 'call_status_callback_received', {
      call_status: normalizedStatus,
      call_duration: Number.isFinite(parsedDuration) ? parsedDuration : null,
      direction: args.direction ?? null,
      from_masked: maskPhoneForCallDiagnostics(args.from),
      to_masked: maskPhoneForCallDiagnostics(args.to),
      error_code: args.errorCode ?? null,
      error_message: args.errorMessage?.slice(0, 200) ?? null,
      timestamp: args.timestamp ?? new Date().toISOString(),
    });

    this.logger.log(
      JSON.stringify({
        event: 'call_status_callback_received',
        callSid: args.callSid,
        callStatus: normalizedStatus,
        callDuration: Number.isFinite(parsedDuration) ? parsedDuration : null,
        direction: args.direction ?? null,
        fromMasked: maskPhoneForCallDiagnostics(args.from),
        toMasked: maskPhoneForCallDiagnostics(args.to),
        errorCode: args.errorCode ?? null,
        errorMessage: args.errorMessage?.slice(0, 200) ?? null,
        timestamp: args.timestamp ?? new Date().toISOString(),
      }),
    );

    if (normalizedStatus === 'completed') {
      const duration =
        record.twilioCallDurationSeconds ??
        (record.startedAt && record.endedAt
          ? Math.round((record.endedAt - record.startedAt) / 1000)
          : null);
      this.logger.log(
        JSON.stringify({
          event: 'call_completed',
          callSid: args.callSid,
          call_duration_seconds: duration,
        }),
      );

      if (
        record.twimlSentAt &&
        duration != null &&
        duration >= 0 &&
        duration <= QUICK_DISCONNECT_THRESHOLD_SECONDS
      ) {
        this.logger.warn(
          JSON.stringify({
            event: 'call_disconnected_quickly',
            callSid: args.callSid,
            call_duration_seconds: duration,
            threshold_seconds: QUICK_DISCONNECT_THRESHOLD_SECONDS,
          }),
        );
        this.logger.warn(
          JSON.stringify({
            event: 'likely_post_twiml_disconnect',
            callSid: args.callSid,
            call_duration_seconds: duration,
            twiml_sent_at: new Date(record.twimlSentAt).toISOString(),
            likely_reason: buildLikelyDisconnectReason('likely_post_twiml_disconnect', {
              twilioErrorCode: record.twilioErrorCode,
              twilioErrorMessage: record.twilioErrorMessage,
              callDurationSeconds: duration,
              registerCallSuccess: record.elevenlabsRegisterCallSuccess,
            }),
          }),
        );
      }
    }

    if (['failed', 'busy', 'no-answer', 'canceled'].includes(normalizedStatus)) {
      this.logger.warn(
        JSON.stringify({
          event: 'call_failed',
          callSid: args.callSid,
          callStatus: normalizedStatus,
          errorCode: args.errorCode ?? null,
          errorMessage: args.errorMessage?.slice(0, 200) ?? null,
        }),
      );
    }
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
    if (args.twilioCallStatus) record.twilioFinalStatus = args.twilioCallStatus;
    record.elevenlabsDisconnectReason =
      args.elevenlabsDisconnectReason ?? record.elevenlabsDisconnectReason;
    record.websocketCloseCode = args.websocketCloseCode ?? record.websocketCloseCode;
    record.websocketCloseReason = args.websocketCloseReason ?? record.websocketCloseReason;
    this.pushEvent(args.callSid, 'call_ended', {
      twilio_call_status: args.twilioCallStatus ?? null,
      elevenlabs_disconnect_reason: args.elevenlabsDisconnectReason ?? null,
      websocket_close_code: args.websocketCloseCode ?? null,
    });
    const durationSec = this.resolveDurationSeconds(record);
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
    this.logger.warn(JSON.stringify({ event: 'tool_timeout', callSid, tool: toolName }));
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
    this.logger.log(JSON.stringify({ event: 'customer_reported_call_cutoff', callSid }));
  }

  getDiagnostics(callSid: string): CallDiagnosticSnapshot | null {
    const record = this.store.get(callSid);
    if (!record) return null;

    const durationSec = this.resolveDurationSeconds(record);
    const stage = inferLikelyFailureStage({
      twimlSentAt: record.twimlSentAt,
      registerCallSuccess: record.elevenlabsRegisterCallSuccess,
      twilioFinalStatus: record.twilioFinalStatus,
      callDurationSeconds: durationSec,
      twilioErrorCode: record.twilioErrorCode,
    });

    return {
      call_sid: record.callSid,
      call_started_at: record.startedAt ? new Date(record.startedAt).toISOString() : null,
      call_ended_at: record.endedAt ? new Date(record.endedAt).toISOString() : null,
      call_duration_seconds: durationSec,
      twilio_call_sid: record.callSid,
      twilio_call_status: record.twilioCallStatus,
      twilio_final_status: record.twilioFinalStatus,
      twilio_error_code: record.twilioErrorCode,
      twilio_error_message: record.twilioErrorMessage,
      elevenlabs_register_call_status: record.elevenlabsRegisterCallStatus,
      elevenlabs_register_call_success: record.elevenlabsRegisterCallSuccess,
      twiml_sent: Boolean(record.twimlSentAt),
      twiml_sent_at: record.twimlSentAt ? new Date(record.twimlSentAt).toISOString() : null,
      twiml_bytes: record.twimlBytes,
      likely_failure_stage: stage,
      likely_reason: buildLikelyDisconnectReason(stage, {
        twilioErrorCode: record.twilioErrorCode,
        twilioErrorMessage: record.twilioErrorMessage,
        callDurationSeconds: durationSec,
        registerCallSuccess: record.elevenlabsRegisterCallSuccess,
      }),
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

  private resolveDurationSeconds(record: CallRecord): number | null {
    if (record.twilioCallDurationSeconds != null) return record.twilioCallDurationSeconds;
    if (record.startedAt && record.endedAt) {
      return Math.round((record.endedAt - record.startedAt) / 1000);
    }
    if (record.startedAt) return Math.round((Date.now() - record.startedAt) / 1000);
    return null;
  }

  private getOrCreate(callSid: string): CallRecord {
    let record = this.store.get(callSid);
    if (!record) {
      record = {
        callSid,
        startedAt: 0,
        endedAt: null,
        twilioCallStatus: null,
        twilioFinalStatus: null,
        twilioErrorCode: null,
        twilioErrorMessage: null,
        twilioCallDurationSeconds: null,
        twilioFromMasked: null,
        twilioToMasked: null,
        twilioDirection: null,
        elevenlabsRegisterCallStatus: null,
        elevenlabsRegisterCallSuccess: null,
        twimlSentAt: null,
        twimlBytes: null,
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
    if (record.events.length > 80) record.events.shift();
  }

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [sid, record] of this.store.entries()) {
      const last = record.endedAt ?? record.startedAt;
      if (last && last < cutoff) this.store.delete(sid);
    }
  }
}
