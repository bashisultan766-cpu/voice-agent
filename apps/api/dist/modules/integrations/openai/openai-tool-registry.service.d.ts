import type { AgentToolPermissions } from '@bookstore-voice-agents/types';
import { RuntimeToolRegistryService, type ChatTool } from '../../tools/runtime-tool-registry.service';
export type { ChatTool };
export interface AgentToolFilter {
    enabledTools?: string[] | null;
    toolPermissions?: AgentToolPermissions | Record<string, unknown> | null;
}
export declare class OpenAIToolRegistryService {
    private readonly runtimeRegistry;
    constructor(runtimeRegistry: RuntimeToolRegistryService);
    getToolsForAgent(filter: AgentToolFilter | string[] | null | undefined): ChatTool[];
    getAllowedToolNames(filter: AgentToolFilter | string[] | null | undefined): string[];
    isToolAllowed(toolName: string, filter: AgentToolFilter | string[] | null | undefined): boolean;
}
