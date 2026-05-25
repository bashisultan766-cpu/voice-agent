/**
 * Autonomous voice runtime types — shared between API and dashboard.
 */

/** Dashboard toggles; resolved to OpenAI tool names at runtime. */
export interface AgentToolPermissions {
  checkoutCreation?: boolean;
  refunds?: boolean;
  discounts?: boolean;
  orderTracking?: boolean;
  supportEscalation?: boolean;
  faqRetrieval?: boolean;
  emailSending?: boolean;
  /** Knowledge base RAG + policy lookups */
  knowledgeBase?: boolean;
  /** Product search, inventory, variant lookup */
  productCatalog?: boolean;
}

export const DEFAULT_TOOL_PERMISSIONS: Required<AgentToolPermissions> = {
  checkoutCreation: true,
  refunds: false,
  discounts: true,
  orderTracking: true,
  supportEscalation: true,
  faqRetrieval: true,
  emailSending: true,
  knowledgeBase: true,
  productCatalog: true,
};

/** Voice personality sliders (0–100). Injected into runtime prompt. */
export interface VoicePersonalityTraits {
  voiceEnergy?: number;
  speakingSpeed?: number;
  politeness?: number;
  upsellAggressiveness?: number;
  humorLevel?: number;
}

export const DEFAULT_VOICE_PERSONALITY: VoicePersonalityTraits = {
  voiceEnergy: 60,
  speakingSpeed: 50,
  politeness: 75,
  upsellAggressiveness: 35,
  humorLevel: 20,
};

/** Per-call short-term memory persisted in CallSession.metadata.conversationMemory */
export interface CallConversationMemory {
  mentionedProducts?: Array<{ productId?: string; title: string; variantId?: string }>;
  customerPreferences?: Record<string, string>;
  collectedEmail?: string | null;
  emailCollected?: boolean;
  checkoutStage?: string;
  lastIntent?: string;
  lastToolCalls?: Array<{ toolName: string; ok: boolean; at: string }>;
  turnCount?: number;
}

/** Unified runtime context passed to every tool handler. */
export interface VoiceRuntimeContext {
  agentId: string;
  tenantId: string;
  storeId: string | null;
  shopifyStore: {
    shopDomain?: string | null;
    storeUrl?: string | null;
    hasAdminToken?: boolean;
  } | null;
  voiceId?: string | null;
  openAiModel?: string | null;
  enabledTools: string[];
  toolPermissions: AgentToolPermissions;
  runtimePolicies: {
    checkoutMode?: string | null;
    askEmailBeforePaymentLink?: boolean;
    maxToolCallsPerTurn?: number;
    handoffEnabled?: boolean;
  };
  customerContext: {
    fromNumber?: string | null;
    collectedEmail?: string | null;
  };
  callSession: {
    id: string;
    metadata?: Record<string, unknown>;
  };
  knowledgeBase: {
    source?: string | null;
    syncEnabled?: boolean;
  };
  personality?: VoicePersonalityTraits;
}

/** Call analytics snapshot written to CallOutcome.metadata */
export interface CallAnalyticsSnapshot {
  detectedIntent?: string;
  productsRequested?: string[];
  conversionOutcome?: 'none' | 'payment_link_sent' | 'order_completed' | 'escalated' | 'callback';
  paymentLinkSent?: boolean;
  orderCompleted?: boolean;
  escalationReason?: string;
}
