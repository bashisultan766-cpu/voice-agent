import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectExplicitLanguageSwitch,
  detectLanguageEveryTurn,
  prependLanguageSwitchAcknowledgment,
  replyInCustomerLanguage,
  updateSessionLanguage,
} from './voice-checkout-language.util';

test('Urdu greeting then English order switches session to English', () => {
  const greeting = detectLanguageEveryTurn('Assalamu alaikum');
  let session = updateSessionLanguage(null, greeting, { requested: null, languageConfidenceScore: 0, phrase: null });
  assert.equal(session.language, 'ur');

  const order = detectLanguageEveryTurn('I want to order a book.');
  session = updateSessionLanguage(session.language, order, detectExplicitLanguageSwitch('I want to order a book.'));
  assert.equal(session.language, 'en');
  assert.equal(session.switched, true);
  assert.match(replyInCustomerLanguage(session.language, 'quantity_prompt'), /How many copies/i);
});

test('explicit please talk to me in English forces English', () => {
  const explicit = detectExplicitLanguageSwitch(
    "I don't understand your language. Please talk to me in English.",
  );
  assert.equal(explicit.requested, 'en');
  const turn = detectLanguageEveryTurn("I don't understand your language. Please talk to me in English.");
  const session = updateSessionLanguage('ur', turn, explicit);
  assert.equal(session.language, 'en');
  assert.equal(session.languageSwitchRequested, true);
});

test('Arabic greeting then English request replies in English', () => {
  const ar = detectLanguageEveryTurn('As-salamu alaikum');
  let session = updateSessionLanguage(null, ar, detectExplicitLanguageSwitch('As-salamu alaikum'));
  const en = detectLanguageEveryTurn('Sure, I need help in English with a book.');
  session = updateSessionLanguage(session.language, en, detectExplicitLanguageSwitch(''));
  assert.equal(session.language, 'en');
});

test('mixed Urdu-English chooses ur-en', () => {
  const mixed = detectLanguageEveryTurn('Salam ji I need this book email bhej do');
  assert.equal(mixed.customerLanguage, 'ur-en');
});

test('language switch ack prepended to checkout reply', () => {
  const ack = "Of course, I'll continue in English.";
  const merged = prependLanguageSwitchAcknowledgment('How many copies would you like?', ack, {
    switchRequested: true,
  });
  assert.match(merged, /Of course, I'll continue in English/);
  assert.match(merged, /How many copies/);
});

test('does not stay stuck in Urdu after English-only utterance', () => {
  let lang = updateSessionLanguage('ur', detectLanguageEveryTurn('Assalamu alaikum'), {
    requested: null,
    languageConfidenceScore: 0,
    phrase: null,
  }).language;
  lang = updateSessionLanguage(lang, detectLanguageEveryTurn('I want to order a book'), {
    requested: null,
    languageConfidenceScore: 0,
    phrase: null,
  }).language;
  assert.equal(lang, 'en');
});
