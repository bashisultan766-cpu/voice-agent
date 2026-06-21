import { Injectable, Logger } from '@nestjs/common';
import type { IntentAnalysisResult } from './types/intent-analysis.types';
import type { RoutingDecision } from './types/routing.types';

const COMPLEX_ACTIONS = new Set(['product_search', 'payment_link', 'general']);

/**
 * Enterprise decision router — AI vs human, refund priority, batch automation.
 */
@Injectable()
export class AIOrchestratorService {
  private readonly logger = new Logger(AIOrchestratorService.name);

  decide(intent: IntentAnalysisResult): RoutingDecision {
    if (intent.emotion === 'angry' || intent.urgency === 'critical') {
      return {
        route: 'human_queue',
        escalate: true,
        skip_llm: true,
        batch_shopify: false,
        callback_required: true,
        reason: intent.emotion === 'angry' ? 'angry_customer' : 'critical_urgency',
      };
    }

    if (intent.refund_risk || (intent.actions.includes('refund') && intent.urgency === 'high')) {
      const skipLlm = !intent.actions.some((a) => COMPLEX_ACTIONS.has(a));
      return {
        route: 'refund_priority',
        escalate: intent.refund_risk && intent.emotion === 'frustrated',
        skip_llm: skipLlm,
        batch_shopify: intent.multi_intent,
        callback_required: intent.refund_risk,
        reason: 'refund_risk_priority',
      };
    }

    if (intent.multi_intent && intent.actions.length > 1) {
      const skipLlm = intent.actions.every((a) => !COMPLEX_ACTIONS.has(a));
      return {
        route: 'automation_batch',
        escalate: false,
        skip_llm: skipLlm,
        batch_shopify: true,
        callback_required: false,
        reason: 'multi_intent_batch',
      };
    }

    const skipLlm = intent.actions.every((a) => !COMPLEX_ACTIONS.has(a)) && !intent.actions.includes('general');

    return {
      route: 'standard_automation',
      escalate: intent.actions.includes('escalate'),
      skip_llm: skipLlm,
      batch_shopify: false,
      callback_required: intent.actions.includes('escalate'),
      reason: 'standard_automation',
    };
  }

  prioritizeActions(intent: IntentAnalysisResult, route: RoutingDecision): IntentAnalysisResult['actions'] {
    const actions = [...intent.actions];
    if (route.route === 'refund_priority') {
      actions.sort((a, b) => {
        const rank = (x: string) =>
          x === 'refund' ? 0 : x === 'order_lookup' ? 1 : x === 'shipping_check' ? 2 : 3;
        return rank(a) - rank(b);
      });
    }
    if (route.escalate && !actions.includes('escalate')) {
      actions.push('escalate');
    }
    return [...new Set(actions)];
  }

  logDecision(callSessionId: string, intent: IntentAnalysisResult, decision: RoutingDecision): void {
    this.logger.log(
      JSON.stringify({
        event: 'voice.ai_orchestrator.decision',
        callSessionId,
        route: decision.route,
        escalate: decision.escalate,
        skip_llm: decision.skip_llm,
        batch_shopify: decision.batch_shopify,
        emotion: intent.emotion,
        urgency: intent.urgency,
        refund_risk: intent.refund_risk,
        multi_intent: intent.multi_intent,
        reason: decision.reason,
      }),
    );
  }
}
