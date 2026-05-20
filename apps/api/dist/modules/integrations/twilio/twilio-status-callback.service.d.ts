import { CallsService } from '../../calls/calls.service';
import { CallEventsService } from '../../analytics/call-events.service';
import { VoiceRuntimeService } from '../../calls/runtime/voice-runtime.service';
export interface TwilioStatusPayload {
    CallSid: string;
    CallStatus: string;
    CallDuration?: string;
    RecordingUrl?: string;
}
export declare class TwilioStatusCallbackService {
    private readonly callsService;
    private readonly callEvents;
    private readonly voiceRuntime;
    private readonly logger;
    constructor(callsService: CallsService, callEvents: CallEventsService, voiceRuntime: VoiceRuntimeService);
    private readonly terminalStatuses;
    handleStatus(payload: TwilioStatusPayload): Promise<void>;
}
