/**
 * Twilio Gather speech gating — keep in sync with TwilioWebhookService.handleGatherMvpVoice.
 * Confidence is advisory only; meaningful transcript text always routes to voice runtime.
 */
export type GatherSpeechGateInput = {
  SpeechResult?: string;
  StableSpeechResult?: string;
  Confidence?: string;
};

export type GatherSpeechRejectReason =
  | 'empty'
  | 'too_short'
  | 'noise_only';

const MEANINGLESS_SPEECH = new Set(['.', '...', 'uh', 'um', 'hmm']);

export function hasMeaningfulSpeech(text: string | undefined | null): boolean {
  if (!text) return false;

  const cleaned = text.trim().toLowerCase();

  if (cleaned.length < 2) return false;

  if (MEANINGLESS_SPEECH.has(cleaned)) return false;

  return true;
}

function mergeGatherSpeechText(input: GatherSpeechGateInput): string {
  const speechResult = (input.SpeechResult ?? '').trim();
  const stable = (input.StableSpeechResult ?? '').trim();
  return speechResult || stable;
}

function parseConfidenceForLog(confidenceRaw: string | undefined): number | null {
  const confidenceStr = (confidenceRaw ?? '').trim();
  if (confidenceStr === '') return null;
  const parsed = Number(confidenceStr);
  return Number.isFinite(parsed) ? parsed : null;
}

export function rejectReasonForSpeech(text: string): GatherSpeechRejectReason | null {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  if (!hasMeaningfulSpeech(text)) {
    const cleaned = trimmed.toLowerCase();
    if (cleaned.length < 2) return 'too_short';
    return 'noise_only';
  }
  return null;
}

export function computeGatherSpeechGate(input: GatherSpeechGateInput): {
  speechTextMerged: string;
  hasUsableSpeech: boolean;
  willCallVoiceRuntime: boolean;
  confidenceParsed: number | null;
  speechAccepted: boolean;
  acceptReason: 'meaningful_text' | null;
  rejectReason: GatherSpeechRejectReason | null;
} {
  const speechTextMerged = mergeGatherSpeechText(input);
  const hasUsableSpeech = hasMeaningfulSpeech(speechTextMerged);
  const willCallVoiceRuntime = hasUsableSpeech;
  const confidenceParsed = parseConfidenceForLog(input.Confidence);
  const rejectReason = hasUsableSpeech ? null : rejectReasonForSpeech(speechTextMerged);

  return {
    speechTextMerged,
    hasUsableSpeech,
    willCallVoiceRuntime,
    confidenceParsed,
    speechAccepted: hasUsableSpeech,
    acceptReason: hasUsableSpeech ? 'meaningful_text' : null,
    rejectReason,
  };
}
