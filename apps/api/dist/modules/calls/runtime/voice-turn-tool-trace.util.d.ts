import type { ToolResult } from './tool-orchestrator.service';
export interface VoiceTurnToolTrace {
    searchProducts?: {
        ok: boolean;
        found: boolean;
        title?: string;
        price?: string | null;
        requiresClarification: boolean;
        errorCode?: string;
    };
    validateEmail?: {
        valid: boolean;
        email: string | null;
    };
    sendPaymentEmail?: {
        ok: boolean;
        deduplicated?: boolean;
        email?: string;
    };
}
export declare function applyVoiceToolTrace(trace: VoiceTurnToolTrace, toolName: string, toolArgs: Record<string, unknown>, result: ToolResult): void;
