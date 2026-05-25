/**
 * Store policy / FAQ topics for retrieval routing (not catalog search).
 */
export type PolicyTopic =
  | 'refund'
  | 'shipping'
  | 'transfer'
  | 'store_hours'
  | 'escalation'
  | 'rejected_order'
  | 'facility_restrictions'
  | 'publication_policy'
  | 'voicemail'
  | 'general_faq';

const POLICY_PATTERNS: Array<{ topic: PolicyTopic; re: RegExp }> = [
  { topic: 'refund', re: /\b(refund|return policy|money back|exchange policy|return window)\b/i },
  { topic: 'shipping', re: /\b(shipping|delivery|ship to|postage|carrier|how long.*(ship|deliver))\b/i },
  { topic: 'transfer', re: /\b(transfer (call|me)|speak to (a |)(human|person|manager|supervisor)|talk to someone)\b/i },
  { topic: 'store_hours', re: /\b(store hours|office hours|opening hours|what time (do you|are you) open|when are you open|closed on)\b/i },
  { topic: 'escalation', re: /\b(escalat|complaint|supervisor|corporate|legal department)\b/i },
  { topic: 'rejected_order', re: /\b(rejected order|order (was |)denied|declined order|order not accepted)\b/i },
  {
    topic: 'facility_restrictions',
    re: /\b(inmate|prison|jail|correctional|facility restriction|institution rules|cdcr|doc number)\b/i,
  },
  {
    topic: 'publication_policy',
    re: /\b(magazine policy|newspaper policy|periodical|subscription rules|publication rules)\b/i,
  },
  { topic: 'voicemail', re: /\b(voicemail|leave a message|callback|call me back)\b/i },
];

export function classifyPolicyTopic(text: string): PolicyTopic | null {
  const t = text.trim();
  if (!t) return null;
  for (const { topic, re } of POLICY_PATTERNS) {
    if (re.test(t)) return topic;
  }
  if (/\b(policy|policies|faq|frequently asked)\b/i.test(t)) return 'general_faq';
  return null;
}

export function isStorePolicyQuestion(text: string): boolean {
  return classifyPolicyTopic(text) !== null;
}

/** Recommended retrieval tools for a policy topic (voice tool names). */
export function policyTopicTools(topic: PolicyTopic): string[] {
  switch (topic) {
    case 'refund':
      return ['get_return_policy', 'retrieve_knowledge_base', 'search_store_faqs'];
    case 'shipping':
      return ['get_shipping_policy', 'estimate_shipping', 'retrieve_knowledge_base', 'search_store_faqs'];
    case 'store_hours':
      return ['get_store_hours', 'get_store_locations', 'search_store_faqs'];
    case 'transfer':
    case 'escalation':
    case 'voicemail':
      return ['escalateToHuman', 'handoff_to_human', 'create_callback_request', 'search_store_faqs'];
    case 'rejected_order':
    case 'facility_restrictions':
    case 'publication_policy':
    case 'general_faq':
    default:
      return ['retrieve_knowledge_base', 'search_store_faqs', 'get_store_policy'];
  }
}

export function policyTopicGuidance(topic: PolicyTopic): string {
  const tools = policyTopicTools(topic).join(', ');
  return `Caller topic: ${topic.replace(/_/g, ' ')}. Before answering, use verified retrieval (${tools}). Do not answer from prompt memory or assumptions.`;
}
