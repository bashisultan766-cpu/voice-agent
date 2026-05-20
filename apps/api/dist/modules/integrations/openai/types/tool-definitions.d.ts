export type VoiceToolJsonSchema = Record<string, unknown>;
export declare const VOICE_AGENT_TOOLS: Array<{
    name: string;
    description: string;
    parameters: VoiceToolJsonSchema;
}>;
export declare const ALL_TOOL_NAMES: string[];
