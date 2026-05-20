export type VoiceToolArgParse = {
    ok: true;
    args: Record<string, unknown>;
} | {
    ok: false;
    message: string;
    field?: string;
};
export declare function parseVoiceToolArgs(toolName: string, raw: Record<string, unknown>): VoiceToolArgParse;
