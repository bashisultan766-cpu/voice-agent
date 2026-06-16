import { Injectable } from '@nestjs/common';
import {
  isPostTwimlStreamIssue,
  isTwilioStreamWebSocketCloseError,
} from './utils/twilio-media-stream-error.util';
import {
  sanitizeTwiMLForLogging,
  twimlStructureFlags,
} from './utils/twiml-sanitize.util';

export type LastTwimlSnapshot = {
  callSid: string | null;
  timestamp: string;
  twimlBytes: number;
  hasConnect: boolean;
  hasConversation: boolean;
  hasStream: boolean;
  contentType: string;
  sanitizedTwiml: string;
  twimlRepaired: boolean;
  repairReason: string | null;
};

export type LastTwilioStatusSnapshot = {
  callSid: string;
  callStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  streamError: string | null;
  sipResponseCode: string | null;
  callDuration: string | null;
  timestamp: string;
};

@Injectable()
export class LastTwimlDebugService {
  private snapshot: LastTwimlSnapshot | null = null;
  private lastStatus: LastTwilioStatusSnapshot | null = null;

  record(args: {
    callSid: string | null;
    twiml: string;
    contentType?: string;
    twimlRepaired?: boolean;
    repairReason?: string | null;
  }): void {
    const flags = twimlStructureFlags(args.twiml);
    this.snapshot = {
      callSid: args.callSid,
      timestamp: new Date().toISOString(),
      twimlBytes: args.twiml.length,
      hasConnect: flags.hasConnect,
      hasConversation: flags.hasConversation,
      hasStream: flags.hasStream,
      contentType: args.contentType ?? 'text/xml; charset=utf-8',
      sanitizedTwiml: sanitizeTwiMLForLogging(args.twiml),
      twimlRepaired: args.twimlRepaired ?? false,
      repairReason: args.repairReason ?? null,
    };
  }

  recordStatusCallback(args: {
    callSid: string;
    callStatus: string;
    errorCode?: string;
    errorMessage?: string;
    streamError?: string;
    sipResponseCode?: string;
    callDuration?: string;
    timestamp?: string;
  }): void {
    this.lastStatus = {
      callSid: args.callSid,
      callStatus: args.callStatus,
      errorCode: args.errorCode?.trim() || null,
      errorMessage: args.errorMessage?.trim().slice(0, 300) || null,
      streamError: args.streamError?.trim().slice(0, 300) || null,
      sipResponseCode: args.sipResponseCode?.trim() || null,
      callDuration: args.callDuration?.trim() || null,
      timestamp: args.timestamp ?? new Date().toISOString(),
    };
  }

  getLast(): LastTwimlSnapshot | null {
    return this.snapshot;
  }

  getLastStatus(): LastTwilioStatusSnapshot | null {
    return this.lastStatus;
  }

  isPostTwiml31921Issue(): boolean {
    const duration = this.lastStatus?.callDuration
      ? Number.parseInt(this.lastStatus.callDuration, 10)
      : null;
    return isPostTwimlStreamIssue({
      twimlHasStream: Boolean(this.snapshot?.hasStream),
      errorCode: this.lastStatus?.errorCode,
      callDurationSeconds: Number.isFinite(duration) ? duration : null,
      callStatus: this.lastStatus?.callStatus,
    });
  }

  lastErrorIs31921(): boolean {
    return isTwilioStreamWebSocketCloseError(this.lastStatus?.errorCode);
  }
}
