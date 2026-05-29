"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.languageDisplayName = languageDisplayName;
exports.detectLanguageFromText = detectLanguageFromText;
exports.normalizeLanguageForTwilio = normalizeLanguageForTwilio;
const LANGUAGE_HINTS = [
    {
        code: 'ur',
        words: ['salam', 'shukriya', 'kitab', 'email', 'payment', 'theek', 'bhai', 'ji'],
    },
    {
        code: 'hi',
        words: ['namaste', 'namaskar', 'dhanyavaad', 'kitab', 'chahiye', 'bhai', 'ji'],
    },
    { code: 'es', words: ['hola', 'gracias', 'precio', 'quiero', 'zapatos', 'talla'] },
    { code: 'fr', words: ['bonjour', 'merci', 'prix', 'chaussure', 'taille', 'acheter'] },
    { code: 'de', words: ['hallo', 'danke', 'preis', 'schuhe', 'groesse', 'kaufen'] },
    {
        code: 'it',
        words: [
            'ciao',
            'buongiorno',
            'buonasera',
            'vorrei',
            'prodotto',
            'ordine',
            'pagamento',
            'email',
            'disponibilita',
            'disponibilità',
            'quanto costa',
            'prezzo',
            'scarpe',
            'taglia',
            'comprare',
        ],
    },
    { code: 'pt', words: ['ola', 'obrigado', 'preco', 'sapato', 'tamanho', 'comprar'] },
    { code: 'nl', words: ['hallo', 'dank', 'prijs', 'schoenen', 'maat', 'kopen'] },
    {
        code: 'ru',
        words: [
            'привет',
            'здравствуйте',
            'хочу',
            'товар',
            'заказ',
            'оплата',
            'почта',
            'есть в наличии',
            'сколько стоит',
        ],
    },
];
function languageDisplayName(code) {
    switch ((code ?? '').trim().toLowerCase()) {
        case 'it':
            return 'Italian';
        case 'ru':
            return 'Russian';
        case 'es':
            return 'Spanish';
        case 'fr':
            return 'French';
        case 'de':
            return 'German';
        case 'ar':
            return 'Arabic';
        case 'hi':
            return 'Hindi';
        case 'ur':
            return 'Urdu';
        case 'pt':
            return 'Portuguese';
        case 'nl':
            return 'Dutch';
        case 'ja':
            return 'Japanese';
        case 'ko':
            return 'Korean';
        case 'zh':
            return 'Chinese';
        case 'bn':
            return 'Bengali';
        default:
            return 'English';
    }
}
function detectLanguageFromText(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return { language: 'en', confidence: 0 };
    if (/[ء-ي]/.test(t))
        return { language: 'ar', confidence: 0.97 };
    if (/[ঀ-৿]/.test(t))
        return { language: 'bn', confidence: 0.97 };
    if (/[ऀ-ॿ]/.test(t))
        return { language: 'hi', confidence: 0.97 };
    if (/[ぁ-ゟ゠-ヿ]/.test(t))
        return { language: 'ja', confidence: 0.97 };
    if (/[가-힯]/.test(t))
        return { language: 'ko', confidence: 0.97 };
    if (/[一-龯]/.test(t))
        return { language: 'zh', confidence: 0.97 };
    if (/[\u0400-\u04ff]/.test(t))
        return { language: 'ru', confidence: 0.985 };
    if (/[ا-ے]/.test(t))
        return { language: 'ur', confidence: 0.96 };
    if (/\bas[- ]?salamu?\s+alaikum\b/i.test(t) || /\bassalam\b/i.test(t)) {
        return { language: 'ur', confidence: 0.94 };
    }
    if (/\bnamaste\b/i.test(t) || /\bnamaskar\b/i.test(t)) {
        return { language: 'hi', confidence: 0.94 };
    }
    if (/\bhola\b/i.test(t))
        return { language: 'es', confidence: 0.92 };
    if (/\bprivet\b/i.test(t))
        return { language: 'ru', confidence: 0.9 };
    if (/^hello\b/i.test(t) || /\bhello\b/.test(t)) {
        return { language: 'en', confidence: 0.88 };
    }
    let best = { language: 'en', confidence: 0.35 };
    for (const hint of LANGUAGE_HINTS) {
        const hits = hint.words.filter((w) => t.includes(w)).length;
        if (hits === 0)
            continue;
        const confidence = Math.min(0.55 + hits * 0.12, 0.92);
        if (confidence > best.confidence) {
            best = { language: hint.code, confidence };
        }
    }
    return best;
}
function normalizeLanguageForTwilio(language) {
    const code = (language ?? '').toLowerCase().trim();
    switch (code) {
        case 'en':
            return 'en-US';
        case 'es':
            return 'es-ES';
        case 'fr':
            return 'fr-FR';
        case 'de':
            return 'de-DE';
        case 'ar':
            return 'ar-SA';
        case 'hi':
            return 'hi-IN';
        case 'ur':
            return 'ur-PK';
        case 'it':
            return 'it-IT';
        case 'pt':
            return 'pt-BR';
        case 'nl':
            return 'nl-NL';
        case 'ja':
            return 'ja-JP';
        case 'ko':
            return 'ko-KR';
        case 'zh':
            return 'cmn-CN';
        case 'bn':
            return 'bn-IN';
        case 'ru':
            return 'ru-RU';
        default:
            return 'en-US';
    }
}
//# sourceMappingURL=language-intelligence.util.js.map