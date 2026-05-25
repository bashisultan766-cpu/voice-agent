import { Injectable } from '@nestjs/common';
import type { AgentToolPermissions } from '@bookstore-voice-agents/types';
import { RuntimeToolRegistryService, type ChatTool } from '../../tools/runtime-tool-registry.service';

export type { ChatTool };

export interface AgentToolFilter {
  enabledTools?: string[] | null;
  toolPermissions?: AgentToolPermissions | Record<string, unknown> | null;
}

@Injectable()
export class OpenAIToolRegistryService {
  constructor(private readonly runtimeRegistry: RuntimeToolRegistryService) {}

  getToolsForAgent(filter: AgentToolFilter | string[] | null | undefined): ChatTool[] {
    const params = Array.isArray(filter) ? { enabledTools: filter } : (filter ?? {});
    return this.runtimeRegistry.getToolsForAgent(params);
  }

  getAllowedToolNames(filter: AgentToolFilter | string[] | null | undefined): string[] {
    const params = Array.isArray(filter) ? { enabledTools: filter } : (filter ?? {});
    return this.runtimeRegistry.resolveEnabledToolNames(params);
  }

  isToolAllowed(toolName: string, filter: AgentToolFilter | string[] | null | undefined): boolean {
    const params = Array.isArray(filter) ? { enabledTools: filter } : (filter ?? {});
    return this.runtimeRegistry.isToolAllowed(toolName, params);
  }
}
