"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var TwilioStatusCallbackService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TwilioStatusCallbackService = void 0;
const common_1 = require("@nestjs/common");
const calls_service_1 = require("../../calls/calls.service");
const call_events_service_1 = require("../../analytics/call-events.service");
const client_1 = require("@prisma/client");
const voice_runtime_service_1 = require("../../calls/runtime/voice-runtime.service");
const TWILIO_TO_STATUS = {
    completed: client_1.CallStatus.COMPLETED,
    busy: client_1.CallStatus.FAILED,
    failed: client_1.CallStatus.FAILED,
    'no-answer': client_1.CallStatus.ABANDONED,
    canceled: client_1.CallStatus.ABANDONED,
};
let TwilioStatusCallbackService = TwilioStatusCallbackService_1 = class TwilioStatusCallbackService {
    constructor(callsService, callEvents, voiceRuntime) {
        this.callsService = callsService;
        this.callEvents = callEvents;
        this.voiceRuntime = voiceRuntime;
        this.logger = new common_1.Logger(TwilioStatusCallbackService_1.name);
        this.terminalStatuses = [client_1.CallStatus.COMPLETED, client_1.CallStatus.FAILED, client_1.CallStatus.ABANDONED];
    }
    async handleStatus(payload) {
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.status_received',
            callSid: payload.CallSid,
            callStatus: payload.CallStatus,
            callDuration: payload.CallDuration,
        }));
        const session = await this.callsService.findOneByTwilioCallSid(payload.CallSid);
        if (!session) {
            this.logger.warn(JSON.stringify({
                event: 'twilio.voice.status_no_session',
                callSid: payload.CallSid,
                callStatus: payload.CallStatus,
            }));
            return;
        }
        if (session.endedAt && this.terminalStatuses.includes(session.status)) {
            return;
        }
        const status = TWILIO_TO_STATUS[payload.CallStatus] ?? client_1.CallStatus.COMPLETED;
        const durationSeconds = payload.CallDuration ? parseInt(payload.CallDuration, 10) : undefined;
        const endedAt = new Date();
        await this.callsService.updateSessionByTwilioCallSid(payload.CallSid, {
            status,
            endedAt,
            durationSeconds,
        });
        const eventType = status === client_1.CallStatus.COMPLETED ? client_1.CallEventType.CALL_COMPLETED : client_1.CallEventType.CALL_FAILED;
        await this.callEvents.log(session.tenantId, session.id, eventType, {
            twilioStatus: payload.CallStatus,
            durationSeconds,
            recordingUrl: payload.RecordingUrl,
        });
        await this.voiceRuntime.onRuntimeDisconnected(session.id);
        this.logger.log(JSON.stringify({
            event: 'twilio.voice.status_applied',
            callSid: payload.CallSid,
            callSessionId: session.id,
            mappedStatus: status,
        }));
    }
};
exports.TwilioStatusCallbackService = TwilioStatusCallbackService;
exports.TwilioStatusCallbackService = TwilioStatusCallbackService = TwilioStatusCallbackService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [calls_service_1.CallsService,
        call_events_service_1.CallEventsService,
        voice_runtime_service_1.VoiceRuntimeService])
], TwilioStatusCallbackService);
//# sourceMappingURL=twilio-status-callback.service.js.map