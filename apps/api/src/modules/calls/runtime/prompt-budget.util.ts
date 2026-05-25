/** Rough token estimate (~4 chars per token for English prose). */
export function estimatePromptTokens(text: string): number {
  const len = text.trim().length;
  if (!len) return 0;
  return Math.ceil(len / 4);
}

export type PromptBudgetStatus = 'ok' | 'warning' | 'oversized';

export type PromptBudgetReport = {
  charCount: number;
  estimatedTokens: number;
  status: PromptBudgetStatus;
  warnings: string[];
  recommendKnowledgeBase: boolean;
  layerBreakdown: Record<string, { chars: number; estimatedTokens: number }>;
};

const WARNING_TOKEN_THRESHOLD = 3_500;
const OVERSIZED_TOKEN_THRESHOLD = 6_000;
const IDENTITY_CHAR_WARNING = 4_000;

export function analyzePromptBudget(layers: Record<string, string>): PromptBudgetReport {
  const layerBreakdown: PromptBudgetReport['layerBreakdown'] = {};
  let charCount = 0;
  for (const [key, value] of Object.entries(layers)) {
    const chars = value?.length ?? 0;
    layerBreakdown[key] = { chars, estimatedTokens: estimatePromptTokens(value ?? '') };
    charCount += chars;
  }
  const estimatedTokens = estimatePromptTokens(
    Object.values(layers)
      .filter(Boolean)
      .join('\n\n'),
  );
  const warnings: string[] = [];
  let status: PromptBudgetStatus = 'ok';

  const identity = layers.agentIdentity ?? '';
  if (identity.length > IDENTITY_CHAR_WARNING) {
    warnings.push(
      `Agent identity layer is large (${identity.length} chars). Move store policies, FAQs, and long rules into the Knowledge Base instead of Main instructions.`,
    );
    status = 'warning';
  }

  if (estimatedTokens >= OVERSIZED_TOKEN_THRESHOLD) {
    warnings.push(
      `Combined runtime prompt is oversized (~${estimatedTokens} tokens). Expect weaker instruction-following; sync policies to KB and shorten identity text.`,
    );
    status = 'oversized';
  } else if (estimatedTokens >= WARNING_TOKEN_THRESHOLD) {
    warnings.push(
      `Combined runtime prompt is large (~${estimatedTokens} tokens). Consider moving FAQs/policies to Knowledge Base retrieval.`,
    );
    if (status === 'ok') status = 'warning';
  }

  const recommendKnowledgeBase =
    status !== 'ok' ||
    /\b(refund|return policy|shipping policy|store hours|faq|inmate|magazine|newspaper)\b/i.test(identity);

  return {
    charCount,
    estimatedTokens,
    status,
    warnings,
    recommendKnowledgeBase,
    layerBreakdown,
  };
}
