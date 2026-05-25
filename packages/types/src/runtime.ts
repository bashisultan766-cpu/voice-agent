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
  mentionedProducts?: Array<{ productId?: string; title: string; variantId?: string; price?: string }>;
  /** Richer discussion history (includes price when known from tools). */
  discussedProducts?: Array<{ productId?: string; title: string; variantId?: string; price?: string }>;
  rejectedProducts?: Array<{ title: string; reason?: string }>;
  customerName?: string | null;
  preferredGenres?: string[];
  customerPreferences?: Record<string, string>;
  cart?: {
    items: Array<{
      productId?: string;
      title: string;
      variantId?: string;
      quantity: number;
      price?: string;
    }>;
  };
  checkoutState?: 'none' | 'confirming' | 'email_pending' | 'link_sent' | 'completed';
  emailConfirmationState?: 'none' | 'pending' | 'confirmed';
  conversationStage?:
    | 'GREETING'
    | 'DISCOVERY'
    | 'RECOMMENDATION'
    | 'OBJECTION_HANDLING'
    | 'CHECKOUT_CONFIRMATION'
    | 'PAYMENT_LINK_CONFIRMATION'
    | 'FOLLOW_UP';
  lastObjection?: string | null;
  collectedEmail?: string | null;
  emailCollected?: boolean;
  checkoutStage?: string;
  lastIntent?: string;
  lastToolCalls?: Array<{ toolName: string; ok: boolean; at: string }>;
  turnCount?: number;
  /** Sales intelligence: budget sensitivity inferred from objections/language. */
  priceSensitivity?: 'low' | 'medium' | 'high';
  /** Sales intelligence: time pressure (gift, deadline, today). */
  purchaseUrgency?: 'low' | 'medium' | 'high';
  preferredTone?: 'direct' | 'friendly' | 'neutral' | string;
  recommendationAccepted?: number;
  recommendationDeclined?: number;
  /** e.g. motivational, religious, street-lit, easy-reading, inmates-popular */
  interestSignals?: string[];
  lastDiscoveryQuestion?: string | null;
}

/** Real-time voice pipeline metrics (CallSession.metadata.voiceStreamMetrics). */
export interface VoiceStreamMetrics {
  streamingMode?: 'gather_deferred' | 'media_stream' | 'sync';
  streamingStatus?: 'idle' | 'listening' | 'processing' | 'speaking' | 'interrupted';
  sttLatencyMs?: number | null;
  llmLatencyMs?: number | null;
  llmTimeToFirstTokenMs?: number | null;
  ttsLatencyMs?: number | null;
  toolLatencyMs?: number | null;
  silenceDurationMs?: number | null;
  interruptionCount?: number;
  partialTranscript?: string | null;
  lastBargeInAt?: string | null;
  agentSpeaking?: boolean;
  chunksEmitted?: number;
  chunksPlayed?: number;
  lastUpdatedAt?: string;
}

/** Estimated provider costs per call (CallSession.metadata.voiceCostMetrics). */
export interface VoiceCostMetrics {
  openaiInputTokens?: number;
  openaiOutputTokens?: number;
  openaiEstimatedUsd?: number;
  elevenlabsCharacters?: number;
  elevenlabsEstimatedUsd?: number;
  totalEstimatedUsd?: number;
  costPerCheckoutUsd?: number | null;
  turns?: number;
}

/** Per-call analytics in CallSession.metadata.runtimeAnalytics */
export interface CallRuntimeAnalytics {
  successfulRecommendations?: number;
  checkoutAttempts?: number;
  checkoutConverted?: boolean;
  abandonedAtStage?: string | null;
  abandonedCheckoutReasons?: string[];
  toolLatencyMs?: Array<{ toolName: string; ms: number; at: string }>;
  hallucinationAttempts?: number;
  refusalTriggers?: number;
  lastRefusalCategory?: string | null;
  lastStage?: string;
  lastUserIntent?: string;
  objectionCounts?: Record<string, number>;
  /** Catalog offers surfaced to the caller */
  recommendationOffers?: number;
  recommendationAccepted?: number;
  recommendationDeclined?: number;
  /** Sum of cart line prices when known (rough AOV signal) */
  estimatedOrderValue?: number;
  conversionEvents?: number;
}

/** Per-turn or rolling scores in CallSession.metadata.runtimeScores */
export interface RuntimeConversationScores {
  conversationQuality: number;
  salesEffectiveness: number;
  hallucinationRisk: number;
  empathy: number;
  updatedAt: string;
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
