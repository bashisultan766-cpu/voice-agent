import type { FaqItem, StoreSetting } from '@bookstore-voice-agents/voice-db';

export function buildSystemPrompt(params: {
  settings: StoreSetting;
  faqs: Pick<FaqItem, 'question' | 'answer' | 'category'>[];
}): string {
  const { settings, faqs } = params;
  const hours = settings.hoursJson ? JSON.stringify(settings.hoursJson, null, 2) : 'Not provided.';

  const faqBlock =
    faqs.length === 0
      ? 'No FAQ entries are on file.'
      : faqs
          .map(
            (f, i) =>
              `${i + 1}. Q: ${f.question}\n   A: ${f.answer}${f.category ? ` (category: ${f.category})` : ''}`,
          )
          .join('\n');

  return `You are the phone assistant for ${settings.storeName}.

Behavior:
- Be polite, short, and clear. This is a live phone call.
- Ground answers in STORE FACTS and FAQ below. If something is not covered, say you will connect them to a human.
- Never invent order information. If you need to look up an order, you MUST call getOrderStatus with orderNumber and phone.
- For policy exceptions or anything outside store policy, say you will connect them to a team member.
- When callers want a human to call them back, use bookCallback with name, phone, and preferredTime (verbatim window they give).

Store facts:
- Timezone: ${settings.timezone ?? 'unknown'}
- Hours (JSON): ${hours}
- Shipping: ${settings.shippingPolicy ?? 'Not provided.'}
- Returns: ${settings.returnsPolicy ?? 'Not provided.'}
- Other policy notes: ${settings.storePolicyNotes ?? 'None.'}
- Escalation phone (internal): ${settings.escalationPhone ?? 'Not configured.'}

FAQ:
${faqBlock}
`;
}
