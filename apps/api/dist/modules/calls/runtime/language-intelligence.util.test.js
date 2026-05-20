"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const language_intelligence_util_1 = require("./language-intelligence.util");
(0, node_test_1.default)('detects Italian and maps to it-IT', () => {
    const input = 'Ciao, vorrei sapere se questo prodotto è disponibile';
    const detected = (0, language_intelligence_util_1.detectLanguageFromText)(input);
    strict_1.default.equal(detected.language, 'it');
    strict_1.default.equal((0, language_intelligence_util_1.normalizeLanguageForTwilio)(detected.language), 'it-IT');
});
(0, node_test_1.default)('detects Russian and maps to ru-RU', () => {
    const input = 'Здравствуйте, я хочу заказать товар';
    const detected = (0, language_intelligence_util_1.detectLanguageFromText)(input);
    strict_1.default.equal(detected.language, 'ru');
    strict_1.default.equal((0, language_intelligence_util_1.normalizeLanguageForTwilio)(detected.language), 'ru-RU');
});
(0, node_test_1.default)('detects Italian from pricing question', () => {
    const input = 'Quanto costa questo prodotto?';
    const detected = (0, language_intelligence_util_1.detectLanguageFromText)(input);
    strict_1.default.equal(detected.language, 'it');
});
(0, node_test_1.default)('detects Russian from pricing question', () => {
    const input = 'Сколько стоит этот товар?';
    const detected = (0, language_intelligence_util_1.detectLanguageFromText)(input);
    strict_1.default.equal(detected.language, 'ru');
});
//# sourceMappingURL=language-intelligence.util.test.js.map