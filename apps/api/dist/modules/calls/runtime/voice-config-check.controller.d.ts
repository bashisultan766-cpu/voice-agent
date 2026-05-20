import { VoiceConfigCheckService } from './voice-config-check.service';
export declare class VoiceConfigCheckController {
    private readonly checkSvc;
    constructor(checkSvc: VoiceConfigCheckService);
    configCheck(tenantId: string, agentIdRaw?: string): Promise<import("./voice-config-check.service").VoiceConfigCheckResponse | {
        error: string;
        message: string;
    }>;
}
