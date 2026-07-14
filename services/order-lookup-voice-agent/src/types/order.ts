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

/** Narrow lookup outcome vocabulary for speech and orchestration surfaces. */
export type OrderLookupStatus =
  | "found"
  | "not_found"
  | "invalid_format"
  | "api_error"
  | "system_maintenance"
  | "throttled";

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
  /**
   * Facility/restriction tags stamped at add time (SSOT for compliance on later qty increases).
   * Prefer these over re-reading lastCatalogSearch alone.
   */
  tags?: string[];
  metafields?: Array<{ namespace: string; key: string; value: string }>;
  /** Live inventory snapshot stamped at add / last stock double-check. */
  inventoryQuantity?: number;
  /** True when low-stock Urgency Guardrail placed a temporary hold. */
  temporaryReservation?: boolean;
  /** Epoch ms when temporary reservation was stamped. */
  reservedAt?: number;
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
  /**
   * One-shot directive injected into the next OpenAI system messages, then cleared.
   * Used for loop escapement (e.g. order-number attempts exhausted).
   */
  pendingLlmSystemNote?: string;
  currentOrder?: StructuredOrder;
  /** True only after a successful get_shopify_order_status lookup this call. */
  orderContextConfirmed?: boolean;
  /**
   * Context lock (`order_lookup_complete`): after a successful lookup, the LLM must not
   * re-invoke get_shopify_order_status for the same order — use cached JSON only.
   */
  orderLookupComplete?: boolean;
  /**
   * Sticky session order memory for this call — set after the first successful lookup.
   * Follow-ups must read from this instead of re-calling Shopify.
   */
  currentSessionOrder?: {
    orderNumber: string;
    customerName?: string;
    fulfillmentStatus?: string;
    financialStatus?: string;
  };
  /**
   * Facility type / state for proactive compliance (e.g. "FL", "federal", "state prison").
   * Required before adding restricted or unrestricted books once compliance gate is active.
   */
  facilityType?: string;
  /** Persistent in-call shopping cart — survives unlimited add/remove cycles. */
  shoppingCart?: ShoppingCartLineItem[];
  /**
   * Transactional cart projection `{ sku|variantId: quantity }` — kept in sync with shoppingCart.
   * Single source of truth for set/add/minus math alongside CurrentSessionOrder.
   */
  currentSessionCart?: Record<string, number>;
  /**
   * When a remove/minus would drop a line below 1, hold the line until the caller confirms
   * full removal (or chooses a different quantity).
   */
  pendingCartRemoval?: {
    variantId: string;
    title: string;
    currentQuantity: number;
  };
  /**
   * Titles / variant IDs the caller declined as proactive upsells this call —
   * never re-suggest within the same session.
   */
  sessionDeclinedRecommendations?: string[];
  /** In-memory catalog candidates for Smart Suggest (tests + optional seed). */
  recommendationCatalog?: Array<{
    title: string;
    variantId: string;
    tags?: string[];
    metafields?: Array<{ namespace: string; key: string; value: string }>;
    price?: string;
  }>;
  /** Pending one-book upsell awaiting yes/no after a successful cart add. */
  pendingProactiveRecommendation?: {
    title: string;
    variantId: string;
    addedTitle: string;
    matchReason: "series" | "genre" | "author";
  };
  /** Most recent successful catalog search — binds update_cart_item_quantity to the right variant. */
  lastCatalogSearch?: {
    title: string;
    variantId?: string;
    unitPrice?: string;
    isbn?: string;
    recordedAt: number;
    /** Available units from catalog search (inventoryQuantity). */
    quantity?: number;
    tags?: string[];
    metafields?: Array<{ namespace: string; key: string; value: string }>;
    similarMatches?: Array<{
      title: string;
      variantId: string;
      tags?: string[];
      metafields?: Array<{ namespace: string; key: string; value: string }>;
      price?: string;
    }>;
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
  /**
   * Disclosure-safe sticky order context for the current call. Replaces the
   * legacy `lastOrderStatusResult` — no raw Shopify OrderStatusResult ever lives
   * in shared session state.
   */
  sessionOrderContext?: {
    /** Opaque reference (order number / GID) — never the raw Shopify object. */
    orderReferenceId: string;
    orderNumber: string;
    verificationLevel: "verified" | "unverified";
    disclosurePolicyVersion: string;
    orderView: import("../agents/orderDisclosurePolicy.js").OrderView;
    fetchedAt: number;
  };
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
  /** Optional STT confidence from ConversationRelay (0–1). */
  confidence?: number | string;
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
  /** When true, a later text/play from us stops current TTS playback. */
  preemptible?: boolean;
  handoffData?: string;
}
