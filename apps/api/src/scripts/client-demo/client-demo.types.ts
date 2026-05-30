export type ClientDemoCheck = {
  key: string;
  pass: boolean;
  details: string;
  fix?: string;
  latencyMs?: number;
};

export type ClientDemoProductValidation = {
  pass: boolean;
  query: string;
  isbnQuery?: string;
  productFound: boolean;
  productId?: string;
  title?: string;
  price?: string;
  inventoryStatus?: string;
  inStock?: boolean;
  checkoutLinkCreated: boolean;
  checkoutUrl?: string;
  checkoutLinkId?: string;
  searchLatencyMs?: number;
  checkoutLatencyMs?: number;
  errors: string[];
};

export type ClientDemoEmailValidation = {
  pass: boolean;
  recipient: string;
  allowlistEnforced: boolean;
  emailSent: boolean;
  emailEventId?: string;
  deliveryStatus?: string;
  providerMessageId?: string;
  resendVerified: boolean;
  sendLatencyMs?: number;
  deliveryLatencyMs?: number;
  errors: string[];
};

export type ClientDemoVoiceValidation = {
  pass: boolean;
  twilioConnected: boolean;
  twilioWebhookVerified: boolean;
  mediaStreamReady: boolean;
  openAiRealtimeConnected: boolean;
  elevenLabsStreaming: boolean;
  gatherFallbackEnabled: boolean;
  liveCallPlaced: boolean;
  callSid?: string;
  callSessionId?: string;
  callStatus?: string;
  bargeInReady: boolean;
  checks: ClientDemoCheck[];
  errors: string[];
};

export type ClientDemoPaymentSafety = {
  pass: boolean;
  stagingMode: boolean;
  productionMode: boolean;
  emailAllowlistConfigured: boolean;
  shopifyTestCheckoutRequired: boolean;
  realCardBlockedInStaging: boolean;
  checks: ClientDemoCheck[];
};

export type ClientDemoLatencyMetrics = {
  productSearchMs?: number;
  checkoutCreateMs?: number;
  emailSendMs?: number;
  emailDeliveryMs?: number;
  callConnectMs?: number;
  totalFlowMs?: number;
  turnLatenciesMs?: number[];
};

export type ClientDemoReport = {
  generatedAt: string;
  pass: boolean;
  mode: 'readiness' | 'live-call';
  tenantId: string;
  agentId: string;
  traceId?: string;
  callResult?: 'connected' | 'failed' | 'skipped';
  product?: ClientDemoProductValidation;
  email?: ClientDemoEmailValidation;
  voice?: ClientDemoVoiceValidation;
  paymentSafety: ClientDemoPaymentSafety;
  readinessChecks: ClientDemoCheck[];
  latency: ClientDemoLatencyMetrics;
  providerErrors: string[];
  preflight?: { ok: boolean; checks: ClientDemoCheck[] };
};
