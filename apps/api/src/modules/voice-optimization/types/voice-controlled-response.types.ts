/** Structured AI voice turn — one TTS payload per caller response. */
export type VoiceResponseAction =
  | 'order_lookup'
  | 'cancel_order'
  | 'refund'
  | 'escalate'
  | 'shipping_status'
  | 'payment_link'
  | 'product_search'
  | 'general';

export interface VoiceControlledResponse {
  /** Full assistant text for logs, transcripts, and SMS/email follow-ups. */
  text_response: string;
  /** Business action the backend executed or should execute next. */
  action: VoiceResponseAction;
  /** Short, TTS-optimized speech (max 1–2 sentences). */
  voice_text: string;
}

export interface VoiceTtsPlaybackResult {
  playbackUrl?: string;
  /** Twilio `<Say>` fallback when ElevenLabs is unavailable or quota-blocked. */
  twilioSayText?: string;
  voiceText: string;
  ttsGenerated: boolean;
  audioCacheHit: boolean;
  elevenlabsApiCallUsed: boolean;
  fallbackReason?: string;
  ttsLatencyMs?: number;
  elevenlabsModel?: string;
  audioCacheKey?: string;
}
