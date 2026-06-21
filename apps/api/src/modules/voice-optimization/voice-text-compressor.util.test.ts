import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compressForVoice,
  stripVoiceGreetings,
  truncateVoiceSentences,
} from './voice-text-compressor.util';

describe('compressForVoice', () => {
  it('strips greetings and keeps 1–2 sentences', () => {
    const raw =
      'Hello! Thanks for calling SureShot Books. I wanted to let you know that your order #1042 shipped yesterday via USPS. You should receive it by Friday. Let me know if you need anything else.';
    const out = compressForVoice(raw);
    assert.ok(!stripVoiceGreetings(raw).toLowerCase().startsWith('hello'));
    assert.ok(out.split(/[.!?]+/).filter(Boolean).length <= 2);
    assert.ok(out.length < raw.length * 0.6);
    assert.match(out, /order #1042|shipped/i);
  });

  it('hard-caps long replies', () => {
    const long = `${'Your order is processing. '.repeat(20)}`.trim();
    const out = compressForVoice(long, { maxChars: 120, maxSentences: 2 });
    assert.ok(out.length <= 121);
  });

  it('returns trimmed single sentence for short input', () => {
    assert.equal(compressForVoice('  Order 99 is on the way.  '), 'Order 99 is on the way.');
  });

  it('truncateVoiceSentences respects maxSentences', () => {
    const t = 'One. Two. Three. Four.';
    assert.equal(truncateVoiceSentences(t, { maxSentences: 2 }), 'One. Two.');
  });
});
