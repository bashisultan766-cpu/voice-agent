import { Injectable, OnModuleInit } from '@nestjs/common';
import { VOICE_AGENT_TOOLS, ALL_TOOL_NAMES } from './types/tool-definitions';
import { assertAllVoiceAgentToolSchemasValid } from './voice-tool-schema.util';

export interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

@Injectable()
export class OpenAIToolRegistryService implements OnModuleInit {
  onModuleInit(): void {
    assertAllVoiceAgentToolSchemasValid(VOICE_AGENT_TOOLS);
  }

  /**
   * Return OpenAI chat tool format for allowed tools only.
   * storeId is NOT in the schema; runtime injects it when executing.
   */
  getToolsForAgent(enabledTools: string[] | null | undefined): ChatTool[] {
    const allowed = this.getAllowedToolNames(enabledTools);
    return VOICE_AGENT_TOOLS.filter((t) => allowed.includes(t.name)).map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  getAllowedToolNames(enabledTools: string[] | null | undefined): string[] {
    if (Array.isArray(enabledTools) && enabledTools.length > 0) {
      return enabledTools.filter((name) => ALL_TOOL_NAMES.includes(name));
    }
    return ALL_TOOL_NAMES;
  }

  isToolAllowed(toolName: string, enabledTools: string[] | null | undefined): boolean {
    return this.getAllowedToolNames(enabledTools).includes(toolName);
  }
}
