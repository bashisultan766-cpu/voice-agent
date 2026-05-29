import { ConfigService } from '@nestjs/config';
export declare class ElevenLabsService {
    private readonly config;
    constructor(config: ConfigService);
    textToSpeech(text: string, voiceId?: string, options?: {
        apiKey?: string;
        modelId?: string;
    }): Promise<Buffer>;
}
