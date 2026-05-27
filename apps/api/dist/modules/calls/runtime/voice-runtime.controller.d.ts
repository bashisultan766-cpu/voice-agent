import { VoiceRuntimeService } from './voice-runtime.service';
import { VoiceLiveMonitorService } from './voice-live-monitor.service';
import { greetingQuerySchema, turnBodySchema } from './voice-runtime.schema';
import type { z } from 'zod';
export declare class VoiceRuntimeController {
    private readonly runtime;
    private readonly liveMonitor;
    constructor(runtime: VoiceRuntimeService, liveMonitor: VoiceLiveMonitorService);
    getGreeting(query: z.infer<typeof greetingQuerySchema>): Promise<{
        greeting: string;
    }>;
    getContext(callSessionId: string): Promise<{
        greeting: string;
        systemPrompt: string;
    }>;
    getLiveMonitor(query: z.infer<typeof greetingQuerySchema>): Promise<{
        ok: boolean;
        message: string;
    } | {
        callSessionId: string;
        conversationStage: string | null;
        orderState: string | null;
        streamingStatus: import("@bookstore-voice-agents/types").VoiceStreamMetrics["streamingStatus"];
        streamingMode: import("@bookstore-voice-agents/types").VoiceStreamMetrics["streamingMode"];
        agentSpeaking: boolean;
        bargeInRequested: boolean;
        interruptionCount: number;
        partialTranscript: string | null;
        deferredJobPhase: string | null;
        latency: {
            sttMs: number | null;
            llmMs: number | null;
            ttsMs: number | null;
            toolMs: number | null;
            llmTimeToFirstTokenMs: number | null;
        };
        cost: import("@bookstore-voice-agents/types").VoiceCostMetrics;
        recentTranscript: Array<{
            role: string;
            content: string;
            at?: string;
        }>;
        activeTools: string[];
        updatedAt: string;
        ok: boolean;
        message?: undefined;
    }>;
    processTurn(body: z.infer<typeof turnBodySchema>): Promise<{
        reply: string;
    }>;
}
