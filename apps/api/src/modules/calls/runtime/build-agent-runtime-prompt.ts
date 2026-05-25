import type { VoiceAgentRuntimeConfig, VoicePersonalityTraits } from '@bookstore-voice-agents/types';
import { checkoutModeDescription, toCheckoutModeApi } from '@bookstore-voice-agents/types';
import type { VoiceSessionContext } from './session-context.service';
import { policyTopicGuidance, type PolicyTopic } from './policy-intent.util';
import { analyzePromptBudget, type PromptBudgetReport } from './prompt-budget.util';
import {
  PLATFORM_LAYER_PROMPT,
  PLATFORM_SHOPIFY_TRUTH_RULES,
} from './platform-runtime-prompts';

/** @deprecated Use PLATFORM_LAYER_PROMPT */
export const AGENT_RUNTIME_PROMPT_TEMPLATE = PLATFORM_LAYER_PROMPT;

/** Enterprise layered runtime prompt (debug + OpenAI system message). */
export type EnterpriseRuntimePromptLayers = {
  platform: string;
  agentIdentity: string;
  storePolicyKnowledge: string;
  runtimeTools: string;
  shopifyTruth: string;
  knowledgeRetrieval: string;
  runtimeContext: string;
  combined: string;
  budget: PromptBudgetReport;
};

/** @deprecated Use EnterpriseRuntimePromptLayers — kept for gradual API migration. */
export type RuntimePromptLayers = {
  platformSafety: string;
  platformCommerce: string;
  agentCustom: string;
  runtimeContext: string;
  combined: string;
  budget?: PromptBudgetReport;
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
  /** Prefetched policy/FAQ snippet for this turn (from retrieval service). */
  knowledgeRetrievalSnapshot?: string | null;
  policyTopic?: PolicyTopic | null;
  /** When true, inject mandatory policy-retrieval turn guidance. */
  policyRetrievalRequired?: boolean;
  /** Sales conversation engine guidance for this turn. */
  salesGuidance?: string | null;
}

function trimOrEmpty(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function buildAgentIdentityLayer(agent: AgentRuntimePromptInput, options?: BuildAgentRuntimePromptOptions): string {
  const cfg = agent.config;
  const agentName = agent.agentName?.trim() || 'Assistant';
  const storeName = agent.storeName?.trim() || 'the store';
  const identityInstructions = trimOrEmpty(cfg?.customSystemPrompt ?? agent.baseSystemPrompt);

  const lines: string[] = [
    'Agent identity layer (editable — persona & style only):',
    `You are ${agentName}, the voice assistant for ${storeName}.`,
  ];

  if (identityInstructions) {
    lines.push('', 'Conversational identity & style (do NOT treat as policy source):', identityInstructions);
  } else {
    lines.push('', 'Use a professional, helpful bookstore voice. No extra identity text configured.');
  }

  if (agent.toneOfVoice?.trim()) lines.push('', `Tone: ${agent.toneOfVoice.trim()}.`);
  if (agent.agentRole?.trim()) lines.push(`Role: ${agent.agentRole.trim()}.`);
  if (agent.agentGoal?.trim()) lines.push(`Goal: ${agent.agentGoal.trim()}.`);
  if (cfg?.forbiddenBehaviors?.trim()) {
    lines.push('', 'Forbidden behaviors:', cfg.forbiddenBehaviors.trim());
  }

  if (agent.greetingMessage?.trim()) {
    lines.push(
      '',
      `Greeting (played at call start; do not repeat every turn): "${agent.greetingMessage.trim()}"`,
    );
  }

  const personality = options?.personality;
  if (personality) {
    const traits: string[] = [];
    if (personality.voiceEnergy != null) {
      traits.push(
        personality.voiceEnergy >= 70 ? 'high energy' : personality.voiceEnergy <= 30 ? 'calm' : 'balanced energy',
      );
    }
    if (personality.speakingSpeed != null) {
      traits.push(
        personality.speakingSpeed >= 70
          ? 'slightly faster pace'
          : personality.speakingSpeed <= 30
            ? 'slower, clear pace'
            : 'natural pace',
      );
    }
    if (personality.politeness != null) {
      traits.push(personality.politeness >= 70 ? 'very polite' : 'friendly and direct');
    }
    if (personality.upsellAggressiveness != null) {
      traits.push(
        personality.upsellAggressiveness >= 70
          ? 'may suggest one related title when natural'
          : personality.upsellAggressiveness <= 30
            ? 'no unsolicited upsell'
            : 'light upsell only when asked',
      );
    }
    if (traits.length) lines.push('', `Speaking style: ${traits.join('; ')}.`);
  }

  const escalationLanguage: string[] = [];
  if (agent.escalationInstructions?.trim()) {
    escalationLanguage.push(`Escalation language: ${agent.escalationInstructions.trim()}`);
  }
  if (agent.transferToHumanEnabled === false) {
    escalationLanguage.push('Human transfer disabled — offer email follow-up instead.');
  }
  if (escalationLanguage.length) lines.push('', ...escalationLanguage);

  return lines.join('\n');
}

function buildStorePolicyKnowledgeLayer(agent: AgentRuntimePromptInput): string {
  const kb = agent.knowledgeBaseSource?.trim();
  const lines: string[] = [
    'Store policy knowledge layer (retrieval-only — not in prompt memory):',
    '- Refund, shipping, transfers, store hours, escalation rules, facility restrictions, publication rules, and FAQs live in the Knowledge Base.',
    '- Always use retrieve_knowledge_base, search_store_faqs, get_shipping_policy, get_return_policy, get_store_hours, or get_store_policy before answering policy questions.',
    '- Do not quote long policy text from the identity layer or from memory.',
  ];
  if (kb) {
    lines.push(`- Knowledge source: ${kb}${agent.knowledgeSyncEnabled === false ? ' (sync may be stale — prefer live retrieval).' : '.'}`);
  }
  lines.push(
    '- Dashboard policy fields (shipping/returns/delivery) are synced to KB — retrieve; do not assume prompt contains current policy.',
  );
  return lines.join('\n');
}

function buildRuntimeToolsLayer(
  agent: AgentRuntimePromptInput,
  options?: BuildAgentRuntimePromptOptions,
): string {
  const cfg = agent.config;
  const checkoutMode = toCheckoutModeApi(cfg?.checkoutMode);
  const lines: string[] = [
    'Runtime tools layer:',
    `Checkout mode: ${checkoutModeDescription(checkoutMode)}`,
  ];

  if (options?.enabledTools?.length) {
    lines.push(`Enabled tools this session: ${options.enabledTools.join(', ')}.`);
  } else {
    lines.push('Enabled tools: resolve from agent tool permissions at runtime.');
  }

  lines.push(
    `Allowed actions: ${trimOrEmpty(agent.allowedActions) || 'Store products, orders, shipping, refunds, checkout.'}`,
    `Restricted topics: ${trimOrEmpty(agent.restrictedActions) || 'None specified.'}`,
  );

  const perms: string[] = [];
  if (agent.transferToHumanEnabled === false) perms.push('Human transfer: disabled.');
  else perms.push('Human transfer: allowed when appropriate.');
  if (cfg?.askEmailBeforePaymentLink !== false) {
    perms.push('Email required before payment link.');
  }
  if (agent.escalationPhone?.trim()) perms.push(`Escalation phone on file: ${agent.escalationPhone.trim()}.`);
  if (agent.escalationEmail?.trim()) perms.push(`Escalation email on file: ${agent.escalationEmail.trim()}.`);
  if (cfg?.supportEmail?.trim()) perms.push(`Support email: ${cfg.supportEmail.trim()}.`);
  lines.push('', ...perms);

  if (agent.orderStatusHandling?.trim()) {
    lines.push(`Order-status handling style: ${agent.orderStatusHandling.trim()}`);
  }
  if (agent.outOfStockHandling?.trim()) {
    lines.push(`Out-of-stock handling style: ${agent.outOfStockHandling.trim()}`);
  }

  return lines.join('\n');
}

function buildKnowledgeRetrievalLayer(options?: BuildAgentRuntimePromptOptions): string {
  const parts: string[] = ['Knowledge retrieval layer (this turn):'];
  if (options?.policyRetrievalRequired && options.policyTopic) {
    parts.push(policyTopicGuidance(options.policyTopic));
  } else {
    parts.push('- Use retrieval tools for any store policy or FAQ question before answering.');
  }
  const snap = options?.knowledgeRetrievalSnapshot?.trim();
  if (snap) {
    parts.push('', 'Prefetched verified context (cite only this; if insufficient, call retrieval again):', snap);
  } else if (options?.policyRetrievalRequired) {
    parts.push('- No prefetch available — call retrieval tools before answering.');
  } else {
    parts.push('- (No policy prefetch for this turn.)');
  }
  return parts.join('\n');
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

  appendix.push(`Primary language: ${lang}.`);
  if (agent.languageMode === 'auto') {
    appendix.push(`Respond in the caller's language when possible. Supported: ${supported}.`);
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
  if (mem) appendix.push(`Session memory (non-catalog): ${mem}`);

  const sales = options?.salesGuidance?.trim();
  if (sales) appendix.push(sales);

  if (appendix.length === 0) return '';
  return ['Runtime orchestration context:', ...appendix.map((l) => `- ${l}`)].join('\n');
}

export function buildEnterpriseRuntimePromptLayers(
  agent: AgentRuntimePromptInput,
  options?: BuildAgentRuntimePromptOptions,
): EnterpriseRuntimePromptLayers {
  const platform = PLATFORM_LAYER_PROMPT;
  const agentIdentity = buildAgentIdentityLayer(agent, options);
  const storePolicyKnowledge = buildStorePolicyKnowledgeLayer(agent);
  const runtimeTools = buildRuntimeToolsLayer(agent, options);
  const shopifyTruth = PLATFORM_SHOPIFY_TRUTH_RULES;
  const knowledgeRetrieval = buildKnowledgeRetrievalLayer(options);
  const runtimeContext = buildRuntimeContextSection(agent, options);

  const combined = [
    platform,
    agentIdentity,
    storePolicyKnowledge,
    runtimeTools,
    shopifyTruth,
    knowledgeRetrieval,
    runtimeContext,
  ]
    .filter((s) => s.trim().length > 0)
    .join('\n\n');

  const budget = analyzePromptBudget({
    platform,
    agentIdentity,
    storePolicyKnowledge,
    runtimeTools,
    shopifyTruth,
    knowledgeRetrieval,
    runtimeContext,
  });

  return {
    platform,
    agentIdentity,
    storePolicyKnowledge,
    runtimeTools,
    shopifyTruth,
    knowledgeRetrieval,
    runtimeContext,
    combined,
    budget,
  };
}

/** Builds layered runtime prompt sections for debug and OpenAI system message. */
export function buildRuntimePromptLayers(
  agent: AgentRuntimePromptInput,
  options?: BuildAgentRuntimePromptOptions,
): RuntimePromptLayers {
  const e = buildEnterpriseRuntimePromptLayers(agent, options);
  return {
    platformSafety: e.platform,
    platformCommerce: e.shopifyTruth,
    agentCustom: e.agentIdentity,
    runtimeContext: [e.storePolicyKnowledge, e.runtimeTools, e.knowledgeRetrieval, e.runtimeContext]
      .filter(Boolean)
      .join('\n\n'),
    combined: e.combined,
    budget: e.budget,
  };
}

export function buildAgentRuntimePrompt(
  agent: AgentRuntimePromptInput,
  options?: BuildAgentRuntimePromptOptions,
): string {
  return buildEnterpriseRuntimePromptLayers(agent, options).combined;
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
