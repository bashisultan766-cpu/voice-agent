import { ConfigService } from '@nestjs/config';
export declare class ElevenLabsService {
    private readonly config;
    private readonly logger;
    constructor(config: ConfigService);
    textToSpeech(text: string, voiceId?: string, options?: {
        apiKey?: string;
        modelId?: string;
        latencyMode?: boolean;
        voiceCall?: boolean;
        callSessionId?: string;
    }): Promise<Buffer>;
}
