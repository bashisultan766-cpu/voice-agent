import { Injectable } from '@nestjs/common';
import type { AgentToolPermissions, VoicePersonalityTraits, VoiceRuntimeContext } from '@bookstore-voice-agents/types';
import { normalizeToolPermissions } from '../../tools/tool-permissions.util';
import { RuntimeToolRegistryService } from '../../tools/runtime-tool-registry.service';
import type { VoiceSessionContext } from './session-context.service';

@Injectable()
export class VoiceRuntimeContextService {
  constructor(private readonly toolRegistry: RuntimeToolRegistryService) {}

  build(
    ctx: VoiceSessionContext,
    callSessionId: string,
    extras?: {
      toolPermissions?: AgentToolPermissions | Record<string, unknown> | null;
      personality?: VoicePersonalityTraits | null;
    },
  ): VoiceRuntimeContext {
    const toolPermissions = normalizeToolPermissions(
      extras?.toolPermissions ??
        (ctx.metadata?.toolPermissions as AgentToolPermissions | undefined),
    );
    const enabledTools = this.toolRegistry.resolveEnabledToolNames({
      toolPermissions,
      enabledTools: ctx.agent.enabledTools,
    });
    const cfg = ctx.agent.config;
    const mem = (ctx.metadata?.conversationMemory ?? {}) as Record<string, unknown>;

    return {
      agentId: ctx.agentId,
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      shopifyStore: ctx.agent.shopify
        ? {
            shopDomain: ctx.agent.shopify.shopDomain,
            storeUrl: ctx.agent.shopify.storeUrl,
            hasAdminToken: ctx.agent.shopify.hasAdminToken,
          }
        : null,
      voiceId: ctx.agent.voiceId ?? ctx.agent.voice ?? null,
      openAiModel: ctx.agent.model ?? null,
      enabledTools,
      toolPermissions,
      runtimePolicies: {
        checkoutMode: cfg?.checkoutMode ?? null,
        askEmailBeforePaymentLink: cfg?.askEmailBeforePaymentLink ?? true,
        maxToolCallsPerTurn: ctx.agent.maxToolCallsPerTurn ?? 2,
        handoffEnabled: ctx.agent.handoffEnabled !== false,
      },
      customerContext: {
        fromNumber: ctx.fromNumber ?? null,
        collectedEmail: typeof mem.collectedEmail === 'string' ? mem.collectedEmail : null,
      },
      callSession: {
        id: callSessionId,
        metadata: ctx.metadata,
      },
      knowledgeBase: {
        source: ctx.agent.knowledgeBaseSource ?? null,
        syncEnabled: ctx.agent.knowledgeSyncEnabled !== false,
      },
      personality: extras?.personality ?? undefined,
    };
  }
}
