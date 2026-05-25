import type { VoiceAgentRuntimeConfig, VoicePersonalityTraits } from '@bookstore-voice-agents/types';
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

Scope and guardrails:
- Only answer questions about this bookstore/store: products, catalog search, orders, shipping, refunds, exchanges, and checkout.
- Refuse and redirect: politics, crime, illegal activity, medical advice, legal advice, financial advice, adult content, hacking, violence, or any topic unrelated to this store.
- Never invent Shopify product names, prices, stock, ISBNs, or descriptions — use tool results from this agent's store only.
- If a product is unavailable or not found in Shopify, say it is unavailable; do not suggest substitutes unless they appear in search results.
- If price is unknown, fetch product details from Shopify before quoting.
- If you are unsure, escalate to human support instead of guessing.
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
- Never ask for card number, CVV, PIN, or banking details on the phone.
- Only complete payment through the official Shopify checkout/payment link sent by email.
- Confirm the customer's email before creating or sending a payment link.
- If email sending is not configured for this agent, do not claim an email was sent — escalate to support instead.

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
  personality?: VoicePersonalityTraits | null;
  /** Tool names exposed to the model this session. */
  enabledTools?: string[];
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
  appendix.push(
    'Use retrieved knowledge base context (retrieve_knowledge_base / search_store_faqs / policy tools) before answering store policy or FAQ questions.',
  );

  const personality = options?.personality;
  if (personality) {
    const traits: string[] = [];
    if (personality.voiceEnergy != null) {
      traits.push(
        personality.voiceEnergy >= 70
          ? 'high energy'
          : personality.voiceEnergy <= 30
            ? 'calm and measured'
            : 'balanced energy',
      );
    }
    if (personality.speakingSpeed != null) {
      traits.push(
        personality.speakingSpeed >= 70
          ? 'slightly faster pace'
          : personality.speakingSpeed <= 30
            ? 'slower, clear pace'
            : 'natural speaking pace',
      );
    }
    if (personality.politeness != null) {
      traits.push(personality.politeness >= 70 ? 'very polite and formal' : 'friendly and direct');
    }
    if (personality.upsellAggressiveness != null) {
      traits.push(
        personality.upsellAggressiveness >= 70
          ? 'proactively suggest related titles when appropriate'
          : personality.upsellAggressiveness <= 30
            ? 'never push add-ons unless asked'
            : 'mention one related item only when natural',
      );
    }
    if (personality.humorLevel != null && personality.humorLevel >= 50) {
      traits.push('light warmth is OK; stay professional');
    }
    if (traits.length) appendix.push(`Voice personality: ${traits.join('; ')}.`);
  }

  if (options?.enabledTools?.length) {
    appendix.push(`Enabled tools this session: ${options.enabledTools.join(', ')}.`);
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
