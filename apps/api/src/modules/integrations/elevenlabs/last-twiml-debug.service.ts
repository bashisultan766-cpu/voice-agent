import { Injectable } from '@nestjs/common';
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
  contentType: string;
  sanitizedTwiml: string;
  twimlRepaired: boolean;
  repairReason: string | null;
};

@Injectable()
export class LastTwimlDebugService {
  private snapshot: LastTwimlSnapshot | null = null;

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
      contentType: args.contentType ?? 'text/xml; charset=utf-8',
      sanitizedTwiml: sanitizeTwiMLForLogging(args.twiml),
      twimlRepaired: args.twimlRepaired ?? false,
      repairReason: args.repairReason ?? null,
    };
  }

  getLast(): LastTwimlSnapshot | null {
    return this.snapshot;
  }
}
