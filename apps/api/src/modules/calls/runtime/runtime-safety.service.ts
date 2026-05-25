import { Injectable } from '@nestjs/common';

export interface SafetyCheckResult {
  blocked: boolean;
  category?: string;
  reason?: string;
}

const BLOCKED_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  { category: 'politics', pattern: /\b(election|president|congress|politic|vote|democrat|republican)\b/i },
  { category: 'crime', pattern: /\b(murder|robbery|steal|illegal weapon|drug deal)\b/i },
  { category: 'adult', pattern: /\b(porn|xxx|nude|sexual content|adult only)\b/i },
  { category: 'hacking', pattern: /\b(hack|exploit|malware|phishing|bypass security|inject prompt)\b/i },
  { category: 'medical', pattern: /\b(diagnos|prescription|medication dosage|symptom treatment)\b/i },
  { category: 'legal', pattern: /\b(sue|lawsuit|legal advice|attorney recommend|contract law)\b/i },
  { category: 'financial_advice', pattern: /\b(invest in|stock tip|crypto advice|tax evasion|loan scheme)\b/i },
  {
    category: 'prompt_injection',
    pattern: /\b(ignore (all|previous) instructions|system prompt|you are now|jailbreak|DAN mode)\b/i,
  },
];

const REFUSAL_MESSAGE =
  'I can only help with this store — products, orders, shipping, and checkout. I cannot help with that topic.';

@Injectable()
export class RuntimeSafetyService {
  checkUserInput(text: string): SafetyCheckResult {
    const trimmed = text?.trim() ?? '';
    if (!trimmed) return { blocked: false };
    for (const { category, pattern } of BLOCKED_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          blocked: true,
          category,
          reason: `Blocked category: ${category}`,
        };
      }
    }
    return { blocked: false };
  }

  refusalReply(category?: string): string {
    if (category === 'prompt_injection') {
      return `${REFUSAL_MESSAGE} How can I help you find a book or check an order today?`;
    }
    return REFUSAL_MESSAGE;
  }
}
