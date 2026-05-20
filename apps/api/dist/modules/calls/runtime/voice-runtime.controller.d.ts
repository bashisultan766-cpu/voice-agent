import { VoiceRuntimeService } from './voice-runtime.service';
import { greetingQuerySchema, turnBodySchema } from './voice-runtime.schema';
import type { z } from 'zod';
export declare class VoiceRuntimeController {
    private readonly runtime;
    constructor(runtime: VoiceRuntimeService);
    getGreeting(query: z.infer<typeof greetingQuerySchema>): Promise<{
        greeting: string;
    }>;
    getContext(callSessionId: string): Promise<{
        greeting: string;
        systemPrompt: string;
    }>;
    processTurn(body: z.infer<typeof turnBodySchema>): Promise<{
        reply: string;
    }>;
}
