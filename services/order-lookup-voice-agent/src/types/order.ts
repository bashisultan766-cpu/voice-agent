export type SpeechChunkKind =
  | "filler"
  | "confirmation"
  | "summary"
  | "refund"
  | "payment"
  | "closing"
  | "error";

export interface SpeechChunk {
  text: string;
  kind: SpeechChunkKind;
  /** Natural micro-pause before this chunk is spoken (ms). Keep low for latency. */
  pauseMs?: number;
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

export interface ProductSearchSlots {
  isbn?: string;
  title?: string;
  category?: string;
}

export interface CallSession {
  callSid: string;
  from: string;
  to: string;
  phase: CallPhase;
  orderNumberAttempts: number;
  currentOrder?: StructuredOrder;
  createdAt: number;
  /** Phase 1 slots — filled before any Shopify product API call. */
  productSlots?: ProductSearchSlots;
  /** Orchestrator: what we're waiting for from the caller. */
  awaitingInput?:
    | "order_number"
    | "product_slot"
    | "product_isbn"
    | "product_title"
    | "product_category"
    | null;
  greetedThisCall?: boolean;
  lastOrchestratorIntent?: string;
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
  type: "text" | "end";
  token?: string;
  last?: boolean;
  interruptible?: boolean;
  handoffData?: string;
}
