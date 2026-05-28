/** Session metadata flags: one orchestrator reply per caller turn. */
export const LLM_REPLY_META = {
  generated: 'llmReplyGenerated',
  finalText: 'llmFinalReplyText',
  generatedAtMs: 'llmReplyGeneratedAtMs',
} as const;

const HIDDEN_FILLER_EXACT = new Set([
  'thanks',
  'thank you',
  'okay',
  'ok',
  'sure',
  'hello',
  'hi',
  'hey',
  'got it',
  'great',
  'sorry',
  'yes',
  'no',
  'yep',
  'nope',
]);

export type HiddenReplyLog = {
  text: string;
  sourceFunction: string;
  originalChars: number;
  reason: string;
};

export function isHiddenFillerReply(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?,]+$/g, '').trim();
  if (!t) return false;
  if (HIDDEN_FILLER_EXACT.has(t)) return true;
  if (t.length <= 12 && /^(thanks|okay|sure|hello|hi|hey|got it|great|sorry)\b/i.test(t)) {
    return true;
  }
  return false;
}

export function readLlmReplyFromMetadata(metadata: Record<string, unknown> | null | undefined): {
  generated: boolean;
  finalText: string | null;
} {
  if (!metadata || typeof metadata !== 'object') {
    return { generated: false, finalText: null };
  }
  const generated = metadata[LLM_REPLY_META.generated] === true;
  const finalText =
    typeof metadata[LLM_REPLY_META.finalText] === 'string'
      ? (metadata[LLM_REPLY_META.finalText] as string)
      : null;
  return { generated, finalText };
}

export function buildLlmReplyMetadataPatch(finalText: string): Record<string, unknown> {
  return {
    [LLM_REPLY_META.generated]: true,
    [LLM_REPLY_META.finalText]: finalText,
    [LLM_REPLY_META.generatedAtMs]: Date.now(),
  };
}

/**
 * After orchestrator reply is ready, block phrase-cache / fallback TTS for other text.
 */
export function shouldBlockNonOrchestratorTts(args: {
  metadata: Record<string, unknown> | null | undefined;
  candidateText: string;
  sourceFunction: string;
  allowEmptySpeechRetry?: boolean;
}): HiddenReplyLog | null {
  const { generated, finalText } = readLlmReplyFromMetadata(args.metadata);
  const text = args.candidateText.trim();
  if (!text) return null;

  if (!generated) {
    if (!args.allowEmptySpeechRetry && isHiddenFillerReply(text)) {
      return {
        text,
        sourceFunction: args.sourceFunction,
        originalChars: text.length,
        reason: 'hidden_filler_without_llm',
      };
    }
    return null;
  }

  if (finalText && text === finalText.trim()) {
    return null;
  }

  return {
    text,
    sourceFunction: args.sourceFunction,
    originalChars: text.length,
    reason: generated ? 'llm_reply_already_generated' : 'non_orchestrator_after_brain',
  };
}
