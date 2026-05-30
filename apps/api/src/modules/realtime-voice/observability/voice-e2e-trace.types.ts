export type VoiceE2EStep =
  | 'call_connected'
  | 'speech_started'
  | 'transcript_final'
  | 'filler_started'
  | 'product_search_started'
  | 'product_search_completed'
  | 'email_verified'
  | 'checkout_created'
  | 'email_sent'
  | 'payment_status_checked'
  | 'call_ended'
  | 'fallback_triggered';

export type VoiceE2EStepRecord = {
  step: VoiceE2EStep;
  timestamp: number;
  latencyMs?: number;
  ok?: boolean;
  provider?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type VoiceE2ETraceSnapshot = {
  traceId: string;
  callSessionId: string;
  startedAt: number;
  endedAt?: number;
  mode: 'synthetic' | 'live';
  steps: VoiceE2EStepRecord[];
};

export type VoiceE2EStagingReport = {
  pass: boolean;
  traceId: string;
  callSessionId: string;
  mode: 'synthetic' | 'live';
  failedProvider?: string;
  checkoutStatus?: string;
  emailDeliveryStatus?: string;
  latency: {
    productSearchMs?: number;
    emailVerifyMs?: number;
    checkoutCreateMs?: number;
    emailSendMs?: number;
    totalFlowMs?: number;
    turnLatenciesMs?: number[];
  };
  steps: VoiceE2EStepRecord[];
  preflight?: { ok: boolean; checks: Array<{ key: string; pass: boolean; details: string }> };
  errors: string[];
};
