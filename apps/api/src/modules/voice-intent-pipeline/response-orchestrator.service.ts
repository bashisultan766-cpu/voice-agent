import { Injectable, Logger } from '@nestjs/common';
import { LlmAgentOrchestratorService } from '../calls/runtime/llm-agent-orchestrator.service';
import { CallsService } from '../calls/calls.service';
import { VoiceOrderService } from '../voice/voice-order.service';
import { VoiceShippingService } from '../voice/services/voice-shipping.service';
import { VoiceEscalationService } from '../voice/services/voice-escalation.service';
import type { VoiceSessionContext } from '../calls/runtime/session-context.service';
import { summarizeForVoice } from './voice-summarizer.util';
import { AIOrchestratorService } from './ai-orchestrator.service';
import { EscalationQueueService } from './escalation-queue.service';
import { VoiceResponseCacheService } from './voice-response-cache.service';
import type {
  ActionExecutionRecord,
  IntentAction,
  IntentAnalysisResult,
  OrchestratedVoiceResponse,
} from './types/intent-analysis.types';
import type { RoutingDecision } from './types/routing.types';

const SHOPIFY_DETERMINISTIC_ACTIONS = new Set<IntentAction>([
  'order_lookup',
  'shipping_check',
  'refund',
  'cancel',
  'escalate',
]);

const MAX_BATCH_ORDERS = 3;

@Injectable()
export class ResponseOrchestratorService {
  private readonly logger = new Logger(ResponseOrchestratorService.name);

  constructor(
    private readonly voiceOrder: VoiceOrderService,
    private readonly voiceShipping: VoiceShippingService,
    private readonly voiceEscalation: VoiceEscalationService,
    private readonly llmAgent: LlmAgentOrchestratorService,
    private readonly callsService: CallsService,
    private readonly aiOrchestrator: AIOrchestratorService,
    private readonly escalationQueue: EscalationQueueService,
    private readonly responseCache: VoiceResponseCacheService,
  ) {}

  needsLlmFallback(intent: IntentAnalysisResult): boolean {
    return intent.actions.some(
      (a) => a === 'product_search' || a === 'payment_link' || a === 'general',
    );
  }

  async orchestrate(args: {
    callSessionId: string;
    intent: IntentAnalysisResult;
    orchestratorSpeech: string;
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
    ctx: VoiceSessionContext;
    callerPhone?: string;
    rawUserText: string;
  }): Promise<OrchestratedVoiceResponse & { llmUsed: boolean; toolNames?: string[] }> {
    const cached = await this.responseCache.getResponse(args.callSessionId, args.rawUserText);
    if (cached) {
      const voice_text = summarizeForVoice({
        text_response: cached.text_response,
        intent: args.intent,
        actions_executed: cached.actions_executed,
      });
      return {
        text_response: cached.text_response,
        voice_text,
        actions_executed: cached.actions_executed,
        intent: args.intent,
        llmUsed: false,
      };
    }

    const route = this.aiOrchestrator.decide(args.intent);
    this.aiOrchestrator.logDecision(args.callSessionId, args.intent, route);
    const prioritizedActions = this.aiOrchestrator.prioritizeActions(args.intent, route);
    const intentWithPriority = { ...args.intent, actions: prioritizedActions };

    let escalation_id: string | undefined;
    let human_queue = route.route === 'human_queue';

    if (route.escalate) {
      const entry = await this.escalationQueue.enqueue({
        callSessionId: args.callSessionId,
        tenantId: args.ctx.tenantId,
        agentId: args.ctx.agentId,
        customerId: args.callerPhone?.trim() || `session:${args.callSessionId}`,
        reason: intentWithPriority.entities.customer_request,
        transcript: args.rawUserText,
        intent: intentWithPriority,
        callbackRequired: route.callback_required,
        callerPhone: args.callerPhone,
      });
      escalation_id = entry.id;
      human_queue = true;
    }

    const actions_executed = route.batch_shopify
      ? await this.executeBatchedActions(intentWithPriority, args)
      : await this.executeSequentialActions(intentWithPriority, args);

    let text_response = this.composeTextFromActions(actions_executed, intentWithPriority);
    let llmUsed = false;
    let toolNames: string[] | undefined;

    const shouldCallLlm =
      !route.skip_llm &&
      (this.needsLlmFallback(intentWithPriority) || text_response.trim().length < 20) &&
      !human_queue;

    if (shouldCallLlm) {
      await this.callsService.mergeSessionMetadata(args.callSessionId, {
        intentAnalysis: intentWithPriority,
        intentContextForLlm: {
          intent: intentWithPriority.intent,
          emotion: intentWithPriority.emotion,
          urgency: intentWithPriority.urgency,
          actions: intentWithPriority.actions,
          entities: intentWithPriority.entities,
          customer_request: intentWithPriority.entities.customer_request,
        },
      });

      const llm = await this.llmAgent.handleTurn(
        args.callSessionId,
        args.orchestratorSpeech,
        args.conversationHistory,
      );
      llmUsed = true;
      toolNames = llm.toolNames;

      if (llm.reply?.trim()) {
        text_response = llm.reply.trim();
        const actionBlock = actions_executed
          .filter((a) => a.success)
          .map((a) => a.summary)
          .join(' ');
        if (actionBlock && !text_response.includes(actionBlock.slice(0, 40))) {
          text_response = `${actionBlock}\n\n${text_response}`;
        }
      }
    } else if (human_queue) {
      text_response =
        args.ctx.agent.escalationMessage?.trim() ??
        `${intentWithPriority.entities.customer_request}\n\nA specialist will follow up shortly.`;
    }

    if (!text_response.trim()) {
      text_response =
        args.ctx.agent.fallbackMessage?.trim() ??
        "I'm here to help. Could you tell me your order number or what you need?";
    }

    const voice_text = summarizeForVoice({
      text_response,
      intent: intentWithPriority,
      actions_executed,
      human_queue,
    });

    const response: OrchestratedVoiceResponse = {
      text_response,
      voice_text: voice_text || text_response.slice(0, 220),
      actions_executed,
      intent: intentWithPriority,
      route,
      escalation_id,
      human_queue,
    };

    await this.responseCache.setResponse(args.callSessionId, args.rawUserText, {
      text_response: response.text_response,
      voice_text: response.voice_text,
      actions_executed: response.actions_executed,
    });

    await this.callsService.mergeSessionMetadata(args.callSessionId, {
      orchestratedVoiceResponse: {
        intent: intentWithPriority.intent,
        emotion: intentWithPriority.emotion,
        urgency: intentWithPriority.urgency,
        route: route.route,
        actions_executed: actions_executed.map((a) => a.action),
        voice_text_chars: response.voice_text.length,
        llm_skipped: !llmUsed,
      },
    });

    this.logger.log(
      JSON.stringify({
        event: 'voice.response.orchestrated',
        callSessionId: args.callSessionId,
        route: route.route,
        llmUsed,
        human_queue,
        batch: route.batch_shopify,
        voiceChars: response.voice_text.length,
      }),
    );

    return { ...response, llmUsed, toolNames };
  }

  private async executeSequentialActions(
    intent: IntentAnalysisResult,
    args: {
      callSessionId: string;
      ctx: VoiceSessionContext;
      callerPhone?: string;
    },
  ): Promise<ActionExecutionRecord[]> {
    const records: ActionExecutionRecord[] = [];
    const orderIds = this.resolveOrderIds(intent);
    for (const action of intent.actions) {
      if (!SHOPIFY_DETERMINISTIC_ACTIONS.has(action)) continue;
      try {
        const record = await this.executeAction(action, {
          orderIds,
          tenantId: args.ctx.tenantId,
          agentId: args.ctx.agentId,
          callSessionId: args.callSessionId,
          callerPhone: args.callerPhone,
          intent,
        });
        if (record) records.push(record);
      } catch (err) {
        records.push({
          action,
          success: false,
          summary: 'I ran into a problem checking that for you.',
          detail: err instanceof Error ? err.message.slice(0, 200) : undefined,
        });
      }
    }
    return records;
  }

  private async executeBatchedActions(
    intent: IntentAnalysisResult,
    args: {
      callSessionId: string;
      ctx: VoiceSessionContext;
      callerPhone?: string;
    },
  ): Promise<ActionExecutionRecord[]> {
    const orderIds = this.resolveOrderIds(intent).slice(0, MAX_BATCH_ORDERS);
    const records: ActionExecutionRecord[] = [];
    const actionSet = new Set(intent.actions);

    if (actionSet.has('order_lookup') && orderIds.length > 0) {
      const lookups = await Promise.all(
        orderIds.map((orderId) =>
          this.executeAction('order_lookup', {
            orderIds: [orderId],
            tenantId: args.ctx.tenantId,
            agentId: args.ctx.agentId,
            callSessionId: args.callSessionId,
            callerPhone: args.callerPhone,
            intent,
          }),
        ),
      );
      records.push(...lookups.filter(Boolean) as ActionExecutionRecord[]);
    }

    if (actionSet.has('shipping_check') && orderIds.length > 0) {
      const ships = await Promise.all(
        orderIds.map((orderId) =>
          this.executeAction('shipping_check', {
            orderIds: [orderId],
            tenantId: args.ctx.tenantId,
            agentId: args.ctx.agentId,
            callSessionId: args.callSessionId,
            callerPhone: args.callerPhone,
            intent,
          }),
        ),
      );
      records.push(...ships.filter(Boolean) as ActionExecutionRecord[]);
    }

    for (const action of ['refund', 'cancel', 'escalate'] as IntentAction[]) {
      if (!actionSet.has(action)) continue;
      const record = await this.executeAction(action, {
        orderIds,
        tenantId: args.ctx.tenantId,
        agentId: args.ctx.agentId,
        callSessionId: args.callSessionId,
        callerPhone: args.callerPhone,
        intent,
      });
      if (record) records.push(record);
    }

    return records;
  }

  private resolveOrderIds(intent: IntentAnalysisResult): string[] {
    const ids = new Set<string>();
    if (intent.entities.order_id) {
      ids.add(intent.entities.order_id.replace(/\D/g, '') || intent.entities.order_id);
    }
    for (const id of intent.entities.order_ids) {
      const clean = id.replace(/\D/g, '') || id;
      if (clean) ids.add(clean);
    }
    return [...ids];
  }

  private async executeAction(
    action: IntentAction,
    ctx: {
      orderIds: string[];
      tenantId: string;
      agentId: string;
      callSessionId: string;
      callerPhone?: string;
      intent: IntentAnalysisResult;
    },
  ): Promise<ActionExecutionRecord | null> {
    const orderNumber = ctx.orderIds[0];
    switch (action) {
      case 'order_lookup': {
        if (!orderNumber) {
          return {
            action,
            success: true,
            summary: 'Please share your order number so I can look it up.',
          };
        }
        const order = await this.voiceOrder.getOrder({
          orderNumber,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          callerPhone: ctx.callerPhone,
        });
        const summary =
          (order as { voiceSummary?: string }).voiceSummary ??
          (order as { suggested_response?: string }).suggested_response ??
          `I looked up order ${orderNumber}.`;
        return { action, success: true, summary: String(summary), orderId: orderNumber };
      }
      case 'shipping_check': {
        if (!orderNumber) {
          return {
            action,
            success: true,
            summary: 'Tell me your order number and I will check shipping.',
          };
        }
        const ship = await this.voiceShipping.getOrderShipping({
          orderNumber,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
        });
        return {
          action,
          success: ship.success,
          summary: ship.suggested_response,
          orderId: orderNumber,
        };
      }
      case 'refund':
        return {
          action,
          success: true,
          summary: orderNumber
            ? `I can help with a refund for order ${orderNumber}. I'll verify the details with you.`
            : 'I can help with your refund—what is the order number?',
          orderId: orderNumber,
        };
      case 'cancel':
        return {
          action,
          success: true,
          summary: orderNumber
            ? `I can look into canceling order ${orderNumber} if it has not shipped yet.`
            : 'Share your order number and I will check if we can cancel it.',
          orderId: orderNumber,
        };
      case 'escalate': {
        const esc = this.voiceEscalation.escalate({
          reason: 'customer_requests_human',
          summary: ctx.intent.entities.customer_request,
          orderNumber: orderNumber,
          callerPhone: ctx.callerPhone,
        });
        return {
          action,
          success: esc.success,
          summary: esc.suggested_response,
        };
      }
      default:
        return null;
    }
  }

  private composeTextFromActions(
    actions: ActionExecutionRecord[],
    intent: IntentAnalysisResult,
  ): string {
    const parts = actions.filter((a) => a.summary.trim()).map((a) => a.summary.trim());
    if (parts.length === 0) return intent.entities.customer_request;
    return parts.join('\n\n');
  }
}
