import { OnModuleInit } from '@nestjs/common';
export interface ChatTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
export declare class OpenAIToolRegistryService implements OnModuleInit {
    onModuleInit(): void;
    getToolsForAgent(enabledTools: string[] | null | undefined): ChatTool[];
    getAllowedToolNames(enabledTools: string[] | null | undefined): string[];
    isToolAllowed(toolName: string, enabledTools: string[] | null | undefined): boolean;
}
