import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProfessionalConversationReply,
  classifyConversationRouteIntent,
  conversationRouteBlocksTools,
  sanitizeBannedVoicePhrases,
  shouldUseProfessionalFastReply,
} from './professional-conversation-policy.util';
import { classifyUserIntent } from './user-intent-classifier.util';
import { extractBookTitlesFromUtterance } from '../../agents/voice-product-query.util';

function route(
  text: string,
  orderState: 'IDLE' | 'PRODUCT_SEARCH' | 'EMAIL_COLLECTING' = 'IDLE',
  hasDiscussedProduct = false,
) {
  const userIntent = classifyUserIntent(text);
  return classifyConversationRouteIntent({
    customerText: text,
    userIntent,
    orderState,
    storeName: 'SureShot Books',
    agentName: 'Justin',
    hasDiscussedProduct,
    selectedProductTitle: hasDiscussedProduct ? 'Atomic Habits' : null,
  });
}

test('how are you uses natural small talk without tools', () => {
  const r = route('how are you');
  assert.equal(r, 'SMALL_TALK');
  assert.equal(conversationRouteBlocksTools(r), true);
  const reply = buildProfessionalConversationReply(r, {
    customerText: 'how are you',
    userIntent: 'small_talk',
    orderState: 'IDLE',
    storeName: 'SureShot Books',
    agentName: 'Justin',
  });
  assert.match(reply ?? '', /doing well/i);
  assert.doesNotMatch(reply ?? '', /go ahead/i);
  assert.doesNotMatch(reply ?? '', /just a moment/i);
});

test('hello returns professional greeting', () => {
  const r = route('hello');
  assert.equal(r, 'GREETING');
  const reply = buildProfessionalConversationReply(r, {
    customerText: 'hello',
    userIntent: 'greeting',
    orderState: 'IDLE',
    storeName: 'SureShot Books',
    agentName: 'Justin',
  });
  assert.match(reply ?? '', /Justin/i);
  assert.match(reply ?? '', /SureShot Books/i);
  assert.match(reply ?? '', /find or order a book/i);
});

test('I need a book routes to BOOK_NEED', () => {
  const r = route('I need a book');
  assert.equal(r, 'BOOK_NEED');
  const reply = buildProfessionalConversationReply(r, {
    customerText: 'I need a book',
    userIntent: 'product_search',
    orderState: 'IDLE',
    storeName: 'SureShot Books',
    agentName: 'Justin',
  });
  assert.match(reply ?? '', /title/i);
  assert.match(reply ?? '', /category/i);
});

test('atomic habits routes to product search and uses tools when query is specific', () => {
  const r = route('do you have atomic habits');
  assert.equal(r, 'PRODUCT_SEARCH');
  assert.equal(shouldUseProfessionalFastReply(r, true), false);
  assert.equal(shouldUseProfessionalFastReply(r, false), true);
});

test('I want the first one moves to checkout when product discussed', () => {
  const r = route('I want the first one', 'PRODUCT_SEARCH', true);
  assert.equal(r, 'PRODUCT_SELECTED');
  const reply = buildProfessionalConversationReply(r, {
    customerText: 'I want the first one',
    userIntent: 'purchase_confirmation',
    orderState: 'PRODUCT_SEARCH',
    storeName: 'SureShot Books',
    agentName: 'Justin',
    selectedProductTitle: 'Atomic Habits',
    hasDiscussedProduct: true,
  });
  assert.match(reply ?? '', /email/i);
  assert.match(reply ?? '', /Atomic Habits/i);
});

test('extracts multiple book titles from one sentence', () => {
  const titles = extractBookTitlesFromUtterance(
    'Do you have Atomic Habits and Rich Dad Poor Dad?',
  );
  assert.equal(titles.length, 2);
  assert.match(titles.join(' '), /Atomic Habits/i);
  assert.match(titles.join(' '), /Rich Dad Poor Dad/i);
});

test('sanitize removes banned robotic phrases', () => {
  assert.doesNotMatch(sanitizeBannedVoicePhrases('Go ahead.'), /go ahead/i);
  assert.equal(sanitizeBannedVoicePhrases('Thank you for asking.').trim(), '');
  assert.doesNotMatch(
    sanitizeBannedVoicePhrases('Just a moment, let me check that for you.'),
    /just a moment.*let me check/i,
  );
  assert.doesNotMatch(sanitizeBannedVoicePhrases('We do dropshipping.'), /dropship/i);
});
