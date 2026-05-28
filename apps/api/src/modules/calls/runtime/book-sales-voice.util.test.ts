import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SURESHOT_INBOUND_GREETING,
  BOOK_NEED_PROMPT,
  formatCategorySearchVoiceSummary,
  formatProductFoundVoiceSummary,
  formatVoiceUsd,
  isGenericBookNeedUtterance,
  resolveInboundGreetingText,
  sanitizeBookstoreVoicePhrases,
  shouldPlayInboundElevenLabsGreeting,
  detectBookCategoryQuery,
} from './book-sales-voice.util';

test('inbound greeting uses SureShot Justin line by default', () => {
  const g = resolveInboundGreetingText(null);
  assert.match(g, /Justin/i);
  assert.match(g, /SureShot Books/i);
  assert.match(g, /find or order a book/i);
  assert.equal(g, SURESHOT_INBOUND_GREETING);
});

test('shouldPlayInboundElevenLabsGreeting requires https origin and voice id', () => {
  assert.equal(
    shouldPlayInboundElevenLabsGreeting({
      hearingDebug: false,
      forceElevenLabsOnly: true,
      voiceId: 'vid_1',
      publicOrigin: 'https://agent.example.com',
    }),
    true,
  );
  assert.equal(
    shouldPlayInboundElevenLabsGreeting({
      hearingDebug: false,
      forceElevenLabsOnly: true,
      voiceId: 'vid_1',
      publicOrigin: 'http://localhost',
    }),
    false,
  );
});

test('generic book need detected', () => {
  assert.equal(isGenericBookNeedUtterance('I need a book'), true);
  assert.equal(isGenericBookNeedUtterance('do you have atomic habits'), false);
});

test('history book category detected', () => {
  assert.equal(detectBookCategoryQuery('I want a history book'), 'history');
});

test('product found response includes price and order ask', () => {
  const line = formatProductFoundVoiceSummary({
    title: 'Atomic Habits',
    variants: [{ price: '18.99', inventory_quantity: 12 }],
  });
  assert.match(line, /Atomic Habits/i);
  assert.match(line, /\$18\.99/);
  assert.match(line, /12 copies in stock/i);
  assert.match(line, /order it/i);
});

test('product found response does not offer order when zero inventory', () => {
  const line = formatProductFoundVoiceSummary({
    title: 'Sold Out Title',
    variants: [{ price: '18.99', inventory_quantity: 0 }],
  });
  assert.match(line, /out of stock/i);
  assert.doesNotMatch(line, /order it/i);
  assert.doesNotMatch(line, /0 copies available/i);
});

test('category search lists price for options', () => {
  const line = formatCategorySearchVoiceSummary('history', [
    { title: 'Book A', variants: [{ price: '10.00', inventory_quantity: 2 }] },
    { title: 'Book B', variants: [{ price: '15.50', inventory_quantity: 0 }] },
  ]);
  assert.match(line, /history/i);
  assert.match(line, /Book A/i);
  assert.match(line, /\$10\.00/);
  assert.match(line, /Which one/i);
});

test('book need prompt asks title author category', () => {
  assert.match(BOOK_NEED_PROMPT, /title/i);
  assert.match(BOOK_NEED_PROMPT, /category/i);
});

test('sanitize removes dropshipping mentions', () => {
  const out = sanitizeBookstoreVoicePhrases('We offer dropshipping for your store.');
  assert.doesNotMatch(out, /dropship/i);
});

test('formatVoiceUsd formats numbers', () => {
  assert.equal(formatVoiceUsd('18.99'), '$18.99');
});
