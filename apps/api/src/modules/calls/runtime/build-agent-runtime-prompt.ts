import type { VoiceAgentRuntimeConfig, VoicePersonalityTraits } from '@bookstore-voice-agents/types';
import { checkoutModeDescription, toCheckoutModeApi } from '@bookstore-voice-agents/types';
import type { VoiceSessionContext } from './session-context.service';
import {
  PLATFORM_ANTI_HALLUCINATION_RULES,
  PLATFORM_COMMERCE_RULES,
  PLATFORM_SAFETY_PROMPT,
} from './platform-runtime-prompts';

/** @deprecated Use layered prompts; kept for tests referencing template sections. */
export const AGENT_RUNTIME_PROMPT_TEMPLATE = PLATFORM_SAFETY_PROMPT;

export type RuntimePromptLayers = {
  platformSafety: string;
  platformCommerce: string;
  agentCustom: string;
  runtimeContext: string;
  combined: string;
};

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
  checkoutStep?: string | null;
  conversationStage?: string | null;
  stageGuidance?: string | null;
  memorySummary?: string | null;
  personality?: VoicePersonalityTraits | null;
  enabledTools?: string[];
}

function policyOrDefault(value: string | null | undefined, fallback: string): string {
  const t = value?.trim();
  return t || fallback;
}

function buildAgentCustomSection(agent: AgentRuntimePromptInput): string {
  const cfg = agent.config;
  const agentName = agent.agentName?.trim() || 'Assistant';
  const storeName = agent.storeName?.trim() || 'the store';
  /** Client system prompt: customSystemPrompt from form, else legacy baseSystemPrompt only here — not in platform layers. */
  const clientInstructions = policyOrDefault(
    cfg?.customSystemPrompt ?? agent.baseSystemPrompt,
    'No additional custom instructions configured.',
  );
  const checkoutMode = toCheckoutModeApi(cfg?.checkoutMode);

  const lines: string[] = [
    `You are ${agentName}, a professional AI voice order booking assistant for ${storeName}.`,
    '',
    'Agent custom instructions (from dashboard):',
    clientInstructions,
  ];

  if (agent.toneOfVoice?.trim()) lines.push('', `Tone: ${agent.toneOfVoice.trim()}.`);
  if (agent.agentRole?.trim()) lines.push(`Role: ${agent.agentRole.trim()}.`);
  if (agent.agentGoal?.trim()) lines.push(`Goal: ${agent.agentGoal.trim()}.`);
  if (cfg?.forbiddenBehaviors?.trim()) {
    lines.push('', 'Forbidden behaviors:', cfg.forbiddenBehaviors.trim());
  }

  lines.push(
    '',
    `Checkout mode: ${checkoutModeDescription(checkoutMode)}.`,
    '',
    'Store policies:',
    `Shipping: ${policyOrDefault(cfg?.shippingPolicy, 'Not configured.')}`,
    `Refunds: ${policyOrDefault(cfg?.returnPolicy ?? agent.returnRefundBehavior, 'Not configured.')}`,
  );
  if (cfg?.exchangePolicy?.trim()) lines.push(`Exchanges: ${cfg.exchangePolicy.trim()}.`);
  if (cfg?.deliveryNotes?.trim()) lines.push(`Delivery: ${cfg.deliveryNotes.trim()}.`);

  lines.push(
    '',
    `Blocked topics: ${policyOrDefault(agent.restrictedActions, 'None specified.')}`,
    `Allowed topics: ${policyOrDefault(agent.allowedActions, 'Store products, orders, shipping, refunds, checkout.')}`,
  );

  const escalationLines: string[] = [];
  if (agent.escalationInstructions?.trim()) escalationLines.push(agent.escalationInstructions.trim());
  if (cfg?.escalationRules?.trim()) escalationLines.push(cfg.escalationRules.trim());
  if (agent.escalationPhone?.trim()) escalationLines.push(`Escalation phone: ${agent.escalationPhone.trim()}`);
  if (agent.escalationEmail?.trim()) escalationLines.push(`Escalation email: ${agent.escalationEmail.trim()}`);
  if (cfg?.fallbackHumanContact?.trim()) {
    escalationLines.push(`Human contact: ${cfg.fallbackHumanContact.trim()}`);
  }
  if (agent.transferToHumanEnabled === false) {
    escalationLines.push('Human transfer is disabled; offer email follow-up.');
  }
  if (escalationLines.length) {
    lines.push('', 'Escalation details:', ...escalationLines.map((l) => `- ${l}`));
  }
  if (cfg?.humanHandoffRules?.trim()) {
    lines.push('', `Handoff rules: ${cfg.humanHandoffRules.trim()}`);
  }
  if (agent.orderStatusHandling?.trim()) {
    lines.push(`Order status: ${agent.orderStatusHandling.trim()}`);
  }
  if (agent.outOfStockHandling?.trim()) {
    lines.push(`Out of stock: ${agent.outOfStockHandling.trim()}`);
  }
  if (cfg?.supportEmail?.trim()) lines.push(`Support email: ${cfg.supportEmail.trim()}`);

  return lines.join('\n');
}

function buildRuntimeContextSection(
  agent: AgentRuntimePromptInput,
  options?: BuildAgentRuntimePromptOptions,
): string {
  const appendix: string[] = [];
  const lang =
    agent.languageMode === 'fixed' && agent.fixedLanguage?.trim()
      ? agent.fixedLanguage.trim()
      : agent.language?.trim() || 'en';
  const supported =
    Array.isArray(agent.supportedLanguages) && agent.supportedLanguages.length > 0
      ? agent.supportedLanguages.join(', ')
      : lang;

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
    'Use retrieved knowledge (retrieve_knowledge_base / search_store_faqs / policy tools) before answering store policy or FAQ questions.',
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

  const step = options?.checkoutStep?.trim();
  if (step) {
    appendix.push(
      `Checkout step (internal): ${step}. If EMAIL_COLLECTION and they want to pay, ask for email only.`,
    );
  }

  const stage = options?.conversationStage?.trim();
  if (stage) {
    appendix.push(`Conversation stage: ${stage}.`);
    const guidance = options?.stageGuidance?.trim();
    if (guidance) appendix.push(`Stage focus: ${guidance}`);
  }

  const mem = options?.memorySummary?.trim();
  if (mem) appendix.push(`Session memory: ${mem}`);

  if (appendix.length === 0) return '';
  return appendix.map((l) => `- ${l}`).join('\n');
}

/** Builds layered runtime prompt sections for debug and OpenAI system message. */
export function buildRuntimePromptLayers(
  agent: AgentRuntimePromptInput,
  options?: BuildAgentRuntimePromptOptions,
): RuntimePromptLayers {
  const platformSafety = PLATFORM_SAFETY_PROMPT;
  const platformCommerce = PLATFORM_COMMERCE_RULES;
  const platformAntiHallucination = PLATFORM_ANTI_HALLUCINATION_RULES;
  const agentCustom = buildAgentCustomSection(agent);
  const runtimeContext = buildRuntimeContextSection(agent, options);

  const parts = [platformSafety, platformCommerce, platformAntiHallucination, agentCustom];
  if (runtimeContext.trim()) {
    parts.push('Runtime context:', runtimeContext);
  }
  const combined = parts.join('\n\n');

  return {
    platformSafety,
    platformCommerce,
    agentCustom,
    runtimeContext,
    combined,
  };
}

export function buildAgentRuntimePrompt(
  agent: AgentRuntimePromptInput,
  options?: BuildAgentRuntimePromptOptions,
): string {
  return buildRuntimePromptLayers(agent, options).combined;
}

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
