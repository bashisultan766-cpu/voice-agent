import { ElevenLabsService } from './elevenlabs.service';
import { elevenLabsTestBodySchema } from './elevenlabs-validation';
import type { z } from 'zod';
export declare class ElevenLabsController {
    private readonly elevenLabs;
    constructor(elevenLabs: ElevenLabsService);
    test(_tenantId: string, body: z.infer<typeof elevenLabsTestBodySchema>): Promise<{
        ok: boolean;
        message: string;
    }>;
}
