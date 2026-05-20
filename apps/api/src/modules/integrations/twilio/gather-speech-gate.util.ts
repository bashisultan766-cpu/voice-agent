/**
 * Twilio Gather speech gating — keep in sync with TwilioWebhookService.handleGatherMvpVoice.
 */
export type GatherSpeechGateInput = {
  SpeechResult?: string;
  StableSpeechResult?: string;
  Confidence?: string;
};

export function computeGatherSpeechGate(input: GatherSpeechGateInput): {
  speechTextMerged: string;
  hasUsableSpeech: boolean;
  willCallVoiceRuntime: boolean;
  confidenceParsed: number | null;
  confidenceIgnored: true;
  speechAccepted: boolean;
} {
  const { SpeechResult, StableSpeechResult, Confidence } = input;
  const speechTextMerged = [SpeechResult, StableSpeechResult]
    .filter(Boolean)
    .join(" ")
    .trim();

  // ✅ ONLY RULE: if text exists → accept it
  const hasUsableSpeech = speechTextMerged.length >= 2;
  const willCallVoiceRuntime = hasUsableSpeech;

  // 🚫 REMOVE these completely from logic:
  // - lowConfidence blocking
  // - confidence thresholds
  // - confidence-based rejection

  // ✅ Keep confidence ONLY for logging
  const confidenceParsed = Confidence ? Number(Confidence) : null;

  return {
    speechTextMerged,
    hasUsableSpeech,
    willCallVoiceRuntime,
    confidenceParsed,
    confidenceIgnored: true,
    speechAccepted: hasUsableSpeech
  };
}
