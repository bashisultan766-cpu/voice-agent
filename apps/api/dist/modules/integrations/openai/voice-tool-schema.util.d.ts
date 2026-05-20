export declare function assertVoiceToolParametersValid(toolName: string, parameters: Record<string, unknown>): void;
export declare function assertAllVoiceAgentToolSchemasValid(tools: ReadonlyArray<{
    name: string;
    parameters: Record<string, unknown>;
}>): void;
export declare function normalizeOpenAiChatCompletionsModel(model: string | undefined | null): string;
