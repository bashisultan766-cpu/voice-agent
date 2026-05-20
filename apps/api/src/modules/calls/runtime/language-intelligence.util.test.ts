import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguageFromText, normalizeLanguageForTwilio } from './language-intelligence.util';

test('detects Italian and maps to it-IT', () => {
  const input = 'Ciao, vorrei sapere se questo prodotto è disponibile';
  const detected = detectLanguageFromText(input);
  assert.equal(detected.language, 'it');
  assert.equal(normalizeLanguageForTwilio(detected.language), 'it-IT');
});

test('detects Russian and maps to ru-RU', () => {
  const input = 'Здравствуйте, я хочу заказать товар';
  const detected = detectLanguageFromText(input);
  assert.equal(detected.language, 'ru');
  assert.equal(normalizeLanguageForTwilio(detected.language), 'ru-RU');
});

test('detects Italian from pricing question', () => {
  const input = 'Quanto costa questo prodotto?';
  const detected = detectLanguageFromText(input);
  assert.equal(detected.language, 'it');
});

test('detects Russian from pricing question', () => {
  const input = 'Сколько стоит этот товар?';
  const detected = detectLanguageFromText(input);
  assert.equal(detected.language, 'ru');
});
