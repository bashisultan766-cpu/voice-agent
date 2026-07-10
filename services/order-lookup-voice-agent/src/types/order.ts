export type SpeechChunkKind =
  | "filler"
  | "confirmation"
  | "summary"
  | "refund"
  | "payment"
  | "dictation"
  | "closing"
  | "error";

export interface SpeechChunk {
  text: string;
  kind: SpeechChunkKind;
  /** Natural micro-pause before this chunk is spoken (ms). Keep low for latency. */
  pauseMs?: number;
  /** When true, TTS prosody preserves the full text (no sentence truncation). */
  preserveFull?: boolean;
  /** Inclusive spatial index of the last digit spoken in this dictation chunk. */
  dictationEndIndex?: number;
}

export interface SpeechPlan {
  chunks: SpeechChunk[];
  tone: "warm" | "empathetic" | "neutral";
}

export type AgentStreamEvent =
  | { type: "chunk"; chunk: SpeechChunk }
  | { type: "done"; phase: CallPhase; endCall?: boolean; lookupMs?: number };

export interface OrderLineItem {
  name: string;
  quantity: number;
}

export interface OrderRefundInfo {
  refunded: boolean;
  reason?: string;
  refundEmail?: string;
  refundAmount?: string;
}

export interface OrderPaymentInfo {
  cardLast4?: string;
  cardBrand?: string;
}

export interface StructuredOrder {
  orderNumber: string;
  customerName: string;
  productCount: number;
  products: OrderLineItem[];
  totalAmount: string;
  shippingFee: string;
  fulfillmentStatus: string;
  financialStatus: string;
  refund: OrderRefundInfo;
  payment: OrderPaymentInfo;
}

export type OrderLookupResult =
  | { status: "found"; order: StructuredOrder }
  | { status: "not_found" }
  | { status: "invalid_format"; message: string }
  | { status: "api_error"; message: string };

export type CallPhase =
  | "greeting"
  | "awaiting_order_number"
  | "lookup_in_progress"
  | "order_disclosed"
  | "follow_up"
  | "ended";

/** Canonical product slot fields — extractor, store, and tools share this shape. */
export interface ProductSearchSlots {
  isbn?: string;
  title?: string;
}

/** Ingress boundary: maps extractor aliases into canonical slots before CallState merge. */
export type IncomingProductSlots = ProductSearchSlots & {
  parsedIsbn?: string;
  wantsRecommendations?: boolean;
};

export interface ShoppingCartLineItem {
  /** Shopify ProductVariant GID for draft order line items. */
  variantId: string;
  productId: string;
  title: string;
  quantity: number;
  /** Per-unit catalog price — required for custom draft-order line items. */
  unitPrice?: string;
  /** @deprecated Use unitPrice — kept for backward compatibility. */
  price?: string;
  isbn?: string;
}

export interface CallSession {
  callSid: string;
  from: string;
  to: string;
  /** Twilio Caller ID (From) — used for cryptographic identity verification. */
  callerPhone?: string;
  /** True when callerPhone matches the Shopify customer's registered phone. */
  isVerifiedCaller?: boolean;
  /** Shopify customer phone from the current order lookup. */
  shopifyCustomerPhone?: string;
  /** Shopify Customer GID from the current order lookup. */
  shopifyCustomerId?: string;
  /** Lifetime order count for the Shopify customer on the current order. */
  totalOrderCount?: number;
  phase: CallPhase;
  orderNumberAttempts: number;
  currentOrder?: StructuredOrder;
  /** Full sanitized Shopify order JSON for invisible LLM follow-up context. */
  currentOrderData?: Record<string, unknown>;
  /** True only after a successful get_shopify_order_status lookup this call. */
  orderContextConfirmed?: boolean;
  /** Persistent in-call shopping cart — survives unlimited add/remove cycles. */
  shoppingCart?: ShoppingCartLineItem[];
  /** Most recent successful catalog search — binds add_to_cart to the right variant. */
  lastCatalogSearch?: {
    title: string;
    variantId?: string;
    unitPrice?: string;
    isbn?: string;
    recordedAt: number;
  };
  /** Last generated Shopify invoice URL for checkout email. */
  pendingInvoiceUrl?: string;
  pendingDraftOrderName?: string;
  /** True after checkout email was sent this call — confirm-once policy. */
  paymentLinkSent?: boolean;
  paymentLinkSentTo?: string;
  /**
   * Unified session memory — single brain buffer for intent, workflow, and product facts.
   * Extra runtime fields are written by agentBrain / sessionMemory helpers.
   */
  sessionMemory?: import("../agents/sessionMemory.js").SessionMemoryState;
  /**
   * Unified conversation flow mode (PURCHASE vs SUPPORT).
   * Authoritative copy — conversationFlowState Map mirrors this when session is registered.
   */
  flowMode?: import("../agents/conversationFlowState.js").ConversationFlowMode;
  /**
   * Unified sovereign surface (catalog_active / order_active / tracking / …).
   * Authoritative copy — ActiveSession Map projects from this via sync.
   */
  sovereignState?:
    | "idle"
    | "order_active"
    | "catalog_active"
    | "cart_active"
    | "checkout_active"
    | "tracking_dictation"
    | "awaiting_notepad_ready"
    | "awaiting_clarification";
  /** Optimistic concurrency token for L2 Postgres session snapshots. */
  persistenceVersion?: number;
  /** Last successful Shopify lookup — drives verification-first disclosure speech. */
  lastOrderStatusResult?: import("../adapters/shopifyStorefrontAdapter.js").OrderStatusResult;
  /** Active order-history drill-down context for verified callers. */
  orderHistoryContext?: import("../agents/orderHistoryFlow.js").OrderHistoryContext;
  /** Support escalation state machine — locks routing during email capture. */
  supportEscalation?: import("../agents/supportEscalationFlow.js").SupportEscalationContext;
  /** Central email confirmation engine — shared by support and payment workflows. */
  emailConfirmation?: import("../agents/emailConfirmationManager.js").EmailConfirmationContext;
  /** Payment-link checkout workflow state (separate from support escalation). */
  paymentCheckout?: import("../agents/paymentCheckoutFlow.js").PaymentCheckoutContext;
  createdAt: number;
  /** Phase 1 slots — filled before any Shopify product API call. */
  productSlots?: IncomingProductSlots;
  /** Orchestrator: what we're waiting for from the caller. */
  awaitingInput?:
    | "order_number"
    | "product_slot"
    | "product_isbn"
    | "product_title"
    | "product_category"
    | null;
  greetedThisCall?: boolean;
  /** Prior call dropped — welcome-back greeting and context restore. */
  welcomeBack?: boolean;
  lastOrchestratorIntent?: string;
  /** Highest-priority workflow context for numeric routing (ISBN vs order number). */
  activeWorkflowContext?:
    | "idle"
    | "email_confirmation"
    | "support_escalation"
    | "payment_checkout"
    | "product_search"
    | "order_lookup";
  /** True after order disclosure offers to read tracking — waits for caller yes. */
  awaitingTrackingOffer?: boolean;
}

export interface TwilioRelayInboundMessage {
  type: "setup" | "prompt" | "dtmf" | "interrupt" | "error";
  callSid?: string;
  voicePrompt?: string;
  last?: boolean;
  from?: string;
  to?: string;
  customParameters?: Record<string, string>;
  digit?: string;
  description?: string;
}

export interface TwilioRelayOutboundMessage {
  type: "text" | "end" | "clear";
  token?: string;
  last?: boolean;
  interruptible?: boolean;
  handoffData?: string;
}
