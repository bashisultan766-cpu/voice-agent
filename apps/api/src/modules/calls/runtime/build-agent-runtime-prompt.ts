import type { VoiceAgentRuntimeConfig } from '@bookstore-voice-agents/types';
import { checkoutModeDescription, toCheckoutModeApi } from '@bookstore-voice-agents/types';
import type { VoiceSessionContext } from './session-context.service';

/** Canonical voice runtime system prompt (placeholders filled from per-agent DB config). */
export const AGENT_RUNTIME_PROMPT_TEMPLATE = `You are {{agentName}}, a professional AI voice order booking assistant for {{storeName}}.

Your job:
Help customers on phone calls discover products, answer store-related questions, and guide them to complete an order through an official Shopify checkout/payment link.

Speaking style:
- Speak naturally, warmly, and briefly.
- Sound like a professional human sales assistant.
- Ask one question at a time.
- Do not give long robotic answers.
- Confirm important details before action.
{{toneLine}}

Business rules:
- Only talk about this Shopify store, its products, orders, shipping, refunds, and checkout.
- Do not answer politics, religion, legal, medical, financial, or unrelated questions.
- If the customer asks unrelated questions, politely say you can only help with store products and orders.
- Never invent product details.
- Use Shopify product data as the source of truth.
- If product information is missing, say you will check or connect them with support.
{{forbiddenBehaviorsLine}}

Order flow:
1. Greet the customer.
2. Ask what they are looking for.
3. Recommend relevant Shopify products.
4. Answer product questions using store data.
5. Confirm product, quantity, customer name, and email.
6. Create or prepare checkout/payment link.
7. Send the payment link by email.
8. Tell customer to complete payment using the secure link.
{{checkoutModeLine}}

Payment safety:
- Never ask for card number, CVV, or banking details on call.
- Only send official checkout/payment links.
- Confirm email before sending.

Escalation:
If customer is angry, asks for human support, asks about a complex issue, or requests something outside your rules, politely escalate to support.
{{escalationDetailsLine}}

Custom store instructions:
{{customSystemPrompt}}

Store policies:
Shipping policy:
{{shippingPolicy}}

Refund policy:
{{refundPolicy}}

Blocked topics:
{{blockedTopics}}

Allowed topics:
{{allowedTopics}}`;

/** Agent + store fields used to assemble the live voice system prompt (no secrets). */
export interface AgentRuntimePromptInput {
  agentId: string;
  agentName: string;
  storeName: string;
  language: string;
  baseSystemPrompt?: string | null;
  agentRole?: string | null;
  agentGoal?: string | null;
  toneOfVoice?: string | null;
  allowedActions?: string | null;
  restrictedActions?: string | null;
  escalationInstructions?: string | null;
  returnRefundBehavior?: string | null;
  orderStatusHandling?: string | null;
  outOfStockHandling?: string | null;
  transferToHumanEnabled?: boolean | null;
  escalationPhone?: string | null;
  escalationEmail?: string | null;
  knowledgeBaseSource?: string | null;
  knowledgeSyncEnabled?: boolean | null;
  greetingMessage?: string | null;
  config?: VoiceAgentRuntimeConfig | null;
  supportedLanguages?: string[] | null;
  languageMode?: 'auto' | 'fixed' | null;
  fixedLanguage?: string | null;
}

export interface BuildAgentRuntimePromptOptions {
  /** Internal checkout step from call session metadata. */
  checkoutStep?: string | null;
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}

function policyOrDefault(value: string | null | undefined, fallback: string): string {
  const t = value?.trim();
  return t || fallback;
}

function optionalLine(prefix: string, value: string | null | undefined): string {
  const t = value?.trim();
  return t ? `${prefix}${t}` : '';
}

/**
 * Builds the full OpenAI system prompt for a single agent from dashboard configuration.
 * Never embeds secrets. Each call session must pass only its resolved agent's data.
 */
export function buildAgentRuntimePrompt(
  agent: AgentRuntimePromptInput,
  options?: BuildAgentRuntimePromptOptions,
): string {
  const cfg = agent.config;
  const agentName = agent.agentName?.trim() || 'Assistant';
  const storeName = agent.storeName?.trim() || 'the store';
  const customSystemPrompt = policyOrDefault(
    cfg?.customSystemPrompt ?? agent.baseSystemPrompt,
    'No additional custom instructions configured.',
  );
  const checkoutMode = toCheckoutModeApi(cfg?.checkoutMode);

  const escalationLines: string[] = [];
  if (agent.escalationInstructions?.trim()) {
    escalationLines.push(agent.escalationInstructions.trim());
  }
  if (cfg?.escalationRules?.trim()) escalationLines.push(cfg.escalationRules.trim());
  if (agent.escalationPhone?.trim()) escalationLines.push(`Escalation phone: ${agent.escalationPhone.trim()}`);
  if (agent.escalationEmail?.trim()) escalationLines.push(`Escalation email: ${agent.escalationEmail.trim()}`);
  if (cfg?.fallbackHumanContact?.trim()) {
    escalationLines.push(`Human contact: ${cfg.fallbackHumanContact.trim()}`);
  }
  if (agent.transferToHumanEnabled === false) {
    escalationLines.push('Human transfer is disabled; offer email follow-up.');
  }

  const lang =
    agent.languageMode === 'fixed' && agent.fixedLanguage?.trim()
      ? agent.fixedLanguage.trim()
      : agent.language?.trim() || 'en';
  const supported =
    Array.isArray(agent.supportedLanguages) && agent.supportedLanguages.length > 0
      ? agent.supportedLanguages.join(', ')
      : lang;

  const filled = fillTemplate(AGENT_RUNTIME_PROMPT_TEMPLATE, {
    agentName,
    storeName,
    toneLine: agent.toneOfVoice?.trim() ? `- Tone: ${agent.toneOfVoice.trim()}.` : '',
    forbiddenBehaviorsLine: optionalLine('- ', cfg?.forbiddenBehaviors),
    checkoutModeLine: `- ${checkoutModeDescription(checkoutMode)}`,
    escalationDetailsLine: escalationLines.length > 0 ? escalationLines.map((l) => `- ${l}`).join('\n') : '',
    customSystemPrompt,
    shippingPolicy: policyOrDefault(cfg?.shippingPolicy, 'Not configured.'),
    refundPolicy: policyOrDefault(
      cfg?.returnPolicy ?? agent.returnRefundBehavior,
      'Not configured.',
    ),
    blockedTopics: policyOrDefault(agent.restrictedActions, 'None specified.'),
    allowedTopics: policyOrDefault(agent.allowedActions, 'Store products, orders, shipping, refunds, checkout.'),
  });

  const appendix: string[] = [];

  if (agent.agentRole?.trim()) appendix.push(`Role focus: ${agent.agentRole.trim()}`);
  if (agent.agentGoal?.trim()) appendix.push(`Goal: ${agent.agentGoal.trim()}`);

  if (agent.greetingMessage?.trim()) {
    appendix.push(
      `Call opening (already played at connect; do not repeat every turn): "${agent.greetingMessage.trim()}"`,
    );
  }

  appendix.push(`Primary language: ${lang}.`);
  if (agent.languageMode === 'auto') {
    appendix.push(`Respond in the caller's language when possible. Supported: ${supported}.`);
  }

  if (agent.knowledgeBaseSource?.trim()) {
    appendix.push(
      `Knowledge base: ${agent.knowledgeBaseSource.trim()}${agent.knowledgeSyncEnabled === false ? ' (prefer live Shopify search).' : ''}`,
    );
  }

  if (cfg?.humanHandoffRules?.trim()) {
    appendix.push(`Checkout/handoff: ${cfg.humanHandoffRules.trim()}`);
  }
  if (agent.orderStatusHandling?.trim()) {
    appendix.push(`Order status handling: ${agent.orderStatusHandling.trim()}`);
  }
  if (agent.outOfStockHandling?.trim()) {
    appendix.push(`Out of stock: ${agent.outOfStockHandling.trim()}`);
  }
  if (cfg?.exchangePolicy?.trim()) appendix.push(`Exchange policy: ${cfg.exchangePolicy.trim()}`);
  if (cfg?.deliveryNotes?.trim()) appendix.push(`Delivery notes: ${cfg.deliveryNotes.trim()}`);
  if (cfg?.supportEmail?.trim()) appendix.push(`Support email: ${cfg.supportEmail.trim()}`);

  const step = options?.checkoutStep?.trim();
  if (step) {
    appendix.push(
      `Checkout step (internal): ${step}. If EMAIL_COLLECTION and they want to pay, ask for email only.`,
    );
  }

  if (appendix.length === 0) return filled.trim();

  return `${filled.trim()}\n\n---\nRuntime context:\n${appendix.map((l) => `- ${l}`).join('\n')}`;
}

/** Map session context to prompt input (single agent per call). */
export function promptInputFromVoiceSessionContext(ctx: VoiceSessionContext): AgentRuntimePromptInput {
  const a = ctx.agent;
  return {
    agentId: ctx.agentId,
    agentName: a.name,
    storeName: ctx.store.name,
    language: a.language,
    baseSystemPrompt: a.baseSystemPrompt,
    agentRole: a.agentRole,
    agentGoal: a.agentGoal,
    toneOfVoice: a.toneOfVoice,
    allowedActions: a.allowedActions,
    restrictedActions: a.restrictedActions,
    escalationInstructions: a.escalationInstructions,
    returnRefundBehavior: a.returnRefundBehavior,
    orderStatusHandling: a.orderStatusHandling,
    outOfStockHandling: a.outOfStockHandling,
    transferToHumanEnabled: a.transferToHumanEnabled,
    escalationPhone: a.escalationPhone,
    escalationEmail: a.escalationEmail,
    knowledgeBaseSource: a.knowledgeBaseSource,
    knowledgeSyncEnabled: a.knowledgeSyncEnabled,
    greetingMessage: a.greetingMessage,
    config: a.config,
    supportedLanguages: a.supportedLanguages,
    languageMode: a.languageMode,
    fixedLanguage: a.fixedLanguage,
  };
}
