import { Injectable, Logger } from '@nestjs/common';
import { CallsService } from '../../calls/calls.service';
import { CallEventsService } from '../../analytics/call-events.service';
import { CallStatus, CallEventType } from '@prisma/client';
import { VoiceRuntimeService } from '../../calls/runtime/voice-runtime.service';

export interface TwilioStatusPayload {
  CallSid: string;
  CallStatus: string;
  CallDuration?: string;
  RecordingUrl?: string;
}

const TWILIO_TO_STATUS: Record<string, CallStatus> = {
  completed: CallStatus.COMPLETED,
  busy: CallStatus.FAILED,
  failed: CallStatus.FAILED,
  'no-answer': CallStatus.ABANDONED,
  canceled: CallStatus.ABANDONED,
};

@Injectable()
export class TwilioStatusCallbackService {
  private readonly logger = new Logger(TwilioStatusCallbackService.name);

  constructor(
    private readonly callsService: CallsService,
    private readonly callEvents: CallEventsService,
    private readonly voiceRuntime: VoiceRuntimeService,
  ) {}

  private readonly terminalStatuses = [CallStatus.COMPLETED, CallStatus.FAILED, CallStatus.ABANDONED] as const;

  async handleStatus(payload: TwilioStatusPayload): Promise<void> {
    this.logger.log(
      JSON.stringify({
        event: 'twilio.voice.status_received',
        callSid: payload.CallSid,
        callStatus: payload.CallStatus,
        callDuration: payload.CallDuration,
      }),
    );

    const session = await this.callsService.findOneByTwilioCallSid(payload.CallSid);
    if (!session) {
      this.logger.warn(
        JSON.stringify({
          event: 'twilio.voice.status_no_session',
          callSid: payload.CallSid,
          callStatus: payload.CallStatus,
        }),
      );
      return;
    }
    if (session.endedAt && this.terminalStatuses.includes(session.status as (typeof this.terminalStatuses)[number])) {
      return;
    }

    const status = TWILIO_TO_STATUS[payload.CallStatus] ?? CallStatus.COMPLETED;
    const durationSeconds = payload.CallDuration ? parseInt(payload.CallDuration, 10) : undefined;
    const endedAt = new Date();

    await this.callsService.updateSessionByTwilioCallSid(payload.CallSid, {
      status,
      endedAt,
      durationSeconds,
    });

    const eventType = status === CallStatus.COMPLETED ? CallEventType.CALL_COMPLETED : CallEventType.CALL_FAILED;
    await this.callEvents.log(session.tenantId, session.id, eventType, {
      twilioStatus: payload.CallStatus,
      durationSeconds,
      recordingUrl: payload.RecordingUrl,
    });

    await this.voiceRuntime.onRuntimeDisconnected(session.id);

    this.logger.log(
      JSON.stringify({
        event: 'twilio.voice.status_applied',
        callSid: payload.CallSid,
        callSessionId: session.id,
        mappedStatus: status,
      }),
    );
  }
}
