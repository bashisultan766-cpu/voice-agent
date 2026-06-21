import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeForVoice, truncateToVoiceSentences } from './voice-summarizer.util';
import type { IntentAnalysisResult } from './types/intent-analysis.types';

const baseIntent: IntentAnalysisResult = {
  intent: 'order_status',
  primary_intent: 'order_status',
  secondary_intents: ['refund request'],
  multi_intent: true,
  entities: {
    order_id: '1042',
    order_ids: ['1042', '1039'],
    products: [],
    quantity: null,
    customer_request:
      'Customer wants order 1042 shipping status and a refund for order 1039.',
  },
  actions: ['order_lookup', 'shipping_check', 'refund'],
  risk_level: 'medium',
  emotion: 'frustrated',
  urgency: 'medium',
  refund_risk: true,
  source: 'openai',
};

describe('summarizeForVoice', () => {
  it('uses action summaries without dropping multi-intent acknowledgment', () => {
    const voice = summarizeForVoice({
      text_response:
        'Order 1042 shipped via USPS on Monday. Refund for 1039 requires email verification per policy section 4.2 JSON metadata.',
      intent: baseIntent,
      actions_executed: [
        {
          action: 'shipping_check',
          success: true,
          summary: 'Order 1042 is on the way via USPS.',
        },
      ],
    });
    assert.ok(voice.length <= 220);
    assert.match(voice, /1042/i);
    assert.ok(!/json|metadata|policy section/i.test(voice));
    assert.match(voice, /also noted|other request|next/i);
  });

  it('truncates to max two sentences', () => {
    const long = 'One. Two. Three. Four.';
    assert.equal(truncateToVoiceSentences(long, 2), 'One. Two.');
  });
});
