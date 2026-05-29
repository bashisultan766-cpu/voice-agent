/**
 * Multilingual voice checkout — per-turn language detection and session updates.
 */
import { detectLanguageFromText, type LanguageDetectionResult } from './language-intelligence.util';

export type CustomerLanguage =
  | 'en'
  | 'ur'
  | 'hi'
  | 'es'
  | 'ru'
  | 'ar'
  | 'ur-en'
  | 'hi-en';

export const SESSION_LANGUAGE_KEY = 'customerLanguage';

export type CheckoutMessageType =
  | 'quantity_prompt'
  | 'email_first_request'
  | 'email_invalid_slow_retry'
  | 'email_invalid_spell_retry'
  | 'email_confirmation'
  | 'payment_link_creating'
  | 'payment_email_sending'
  | 'payment_email_verifying'
  | 'payment_email_success'
  | 'payment_email_failure'
  | 'post_payment_thanks'
  | 'product_checkout_intro'
  | 'language_switch_ack';

const GREETING_ONLY_PATTERNS: Array<{ lang: CustomerLanguage; patterns: RegExp[] }> = [
  {
    lang: 'ur',
    patterns: [
      /^\s*as[- ]?salamu?\s+alaikum\s*$/i,
      /^\s*assalamu?\s+alaikum\s*$/i,
      /^\s*salam\s*$/i,
      /^\s*assalam\s*$/i,
      /^\s*wa\s+alaikum\s+salam\s*$/i,
    ],
  },
  { lang: 'hi', patterns: [/^\s*namaste\s*$/i, /^\s*namaskar\s*$/i] },
  { lang: 'es', patterns: [/^\s*hola\s*$/i] },
  { lang: 'ru', patterns: [/^\s*privet\s*$/i] },
  { lang: 'ar', patterns: [/^\s*marhaba\s*$/i, /^\s*ahlan\s*$/i] },
];

const MIXED_UR_EN_MARKERS = /\b(ji|bhai|aap|mujhe|chahiye|kitab|book|email|payment)\b/i;
const MIXED_HI_EN_MARKERS = /\b(ji|bhai|aap|mujhe|chahiye|kitab|book|email|payment)\b/i;

const LATIN_ENGLISH_MARKERS =
  /\b(i\s+want|i\s+need|i\s+don'?t|order|book|books|email|english|please|help|payment|copy|copies|understand|speak|talk|correct|wrong|yes|no|thank)\b/i;

/** Explicit customer requests to change conversation language. */
const EXPLICIT_LANGUAGE_SWITCH: Array<{
  lang: CustomerLanguage;
  patterns: RegExp[];
}> = [
  {
    lang: 'en',
    patterns: [
      /\bspeak\s+english\b/i,
      /\btalk\s+to\s+me\s+in\s+english\b/i,
      /\bplease\s+talk\s+.*\bin\s+english\b/i,
      /\bplease\s+speak\s+.*\bin\s+english\b/i,
      /\bin\s+english\b/i,
      /\bi\s+don'?t\s+understand\s+(your\s+)?language\b/i,
      /\bcan\s+you\s+speak\s+english\b/i,
      /\buse\s+english\b/i,
    ],
  },
  {
    lang: 'ur',
    patterns: [/\burdu\s+mein\s+bolo\b/i, /\burdu\s+me\s+bolo\b/i, /\bin\s+urdu\b/i, /\burdu\s+mein\b/i],
  },
  {
    lang: 'hi',
    patterns: [/\bhindi\s+mein\s+bolo\b/i, /\bhindi\s+me\s+bolo\b/i, /\bin\s+hindi\b/i],
  },
  {
    lang: 'ar',
    patterns: [/\barabic\s+mein\s+bolo\b/i, /\bin\s+arabic\b/i, /\bبالعربية\b/],
  },
  {
    lang: 'es',
    patterns: [/\bspeak\s+spanish\b/i, /\bin\s+spanish\b/i, /\bhabla\s+español\b/i],
  },
  {
    lang: 'ru',
    patterns: [/\bspeak\s+russian\b/i, /\bin\s+russian\b/i, /\bпо-русски\b/i],
  },
];

const COPY: Record<CheckoutMessageType, Record<CustomerLanguage, string>> = {
  language_switch_ack: {
    en: "Of course, I'll continue in English.",
    ur: "Of course, I'll continue in English.",
    hi: "Of course, I'll continue in English.",
    es: 'Por supuesto, continuaré en inglés.',
    ru: 'Конечно, продолжу на английском.',
    ar: 'بالطبع، سأتابع بالإنجليزية.',
    'ur-en': "Of course, I'll continue in English.",
    'hi-en': "Of course, I'll continue in English.",
  },
  product_checkout_intro: {
    en: "Perfect. I'll help you place the order.",
    ur: 'بہترین۔ میں آپ کا آرڈر مکمل کرنے میں مدد کروں گا۔',
    hi: 'बहुत अच्छा। मैं आपका ऑर्डर पूरा करने में मदद करूँगा।',
    es: 'Perfecto. Le ayudaré a realizar el pedido.',
    ru: 'Отлично. Я помогу вам оформить заказ.',
    ar: 'ممتاز. سأساعدك في إتمام الطلب.',
    'ur-en': "Perfect. I'll help you place the order.",
    'hi-en': "Perfect. I'll help you place the order.",
  },
  quantity_prompt: {
    en: 'Perfect. How many copies would you like?',
    ur: 'بہترین۔ آپ کتنی کاپیاں چاہیں گے؟',
    hi: 'बहुत अच्छा। आप कितनी प्रतियाँ चाहेंगे?',
    es: 'Perfecto. ¿Cuántas copias desea?',
    ru: 'Отлично. Сколько экземпляров вам нужно?',
    ar: 'ممتاز. كم نسخة تريد؟',
    'ur-en': 'Perfect. Kitni copies chahiye?',
    'hi-en': 'Perfect. Kitni copies chahiye?',
  },
  email_first_request: {
    en: 'Please tell me your email address so I can send your payment link.',
    ur: 'براہ کرم اپنا ای میل ایڈریس بتا دیں تاکہ میں آپ کو پیمنٹ لنک بھیج سکوں۔',
    hi: 'कृपया अपना ईमेल एड्रेस बताइए ताकि मैं आपको पेमेंट लिंक भेज सकूं।',
    es: 'Por favor, dígame su correo electrónico para enviarle el enlace de pago.',
    ru: 'Пожалуйста, скажите ваш адрес электронной почты, чтобы я мог отправить ссылку для оплаты.',
    ar: 'من فضلك أخبرني بعنوان بريدك الإلكتروني لأرسل رابط الدفع.',
    'ur-en': 'Please apna email address bata dein taake main payment link bhej sakoon.',
    'hi-en': 'Please apna email address bataiye taaki main payment link bhej sakoon.',
  },
  email_invalid_slow_retry: {
    en: "I couldn't verify that email. Please repeat your email address slowly.",
    ur: 'میں اس ای میل کی تصدیق نہیں کر سکا۔ براہ کرم اپنا ای میل آہستہ دہرائیں۔',
    hi: 'मैं उस ईमेल की पुष्टि नहीं कर सका। कृपया अपना ईमेल धीरे-धीरे दोहराएँ।',
    es: 'No pude verificar ese correo. Por favor, repita su correo lentamente.',
    ru: 'Не удалось проверить этот адрес. Повторите email медленно.',
    ar: 'لم أتمكن من التحقق من البريد. يرجى تكرار بريدك ببطء.',
    'ur-en': "I couldn't verify that email. Please apna email slowly repeat karein.",
    'hi-en': "I couldn't verify that email. Please apna email slowly repeat kijiye.",
  },
  email_invalid_spell_retry: {
    en: 'I may not have captured that correctly. Please spell your email address letter by letter.',
    ur: 'شاید میں نے غلط لکھ لیا۔ براہ کرم اپنا ای میل حرف بہ حرف بتائیں۔',
    hi: 'शायद मैंने गलत लिख लिया। कृपया अपना ईमेल अक्षर दर अक्षर बताएँ।',
    es: 'Puede que lo haya capturado mal. Deletree su correo letra por letra.',
    ru: 'Возможно, я записал неверно. Произнесите email по буквам.',
    ar: 'ربما سجلته خطأ. يرجى تهجئة بريدك حرفاً حرفاً.',
    'ur-en': 'Shayad galat capture hua. Please email letter by letter spell karein.',
    'hi-en': 'Shayad galat capture hua. Please email letter by letter spell kijiye.',
  },
  email_confirmation: {
    en: 'Just to confirm, I captured your email as {spoken}. Is that correct?',
    ur: 'تصدیق کے لیے، آپ کا ای میل {spoken} ہے۔ کیا یہ درست ہے؟',
    hi: 'पुष्टि के लिए, आपका ईमेल {spoken} है। क्या यह सही है?',
    es: 'Para confirmar, capturé su correo como {spoken}. ¿Es correcto?',
    ru: 'Для подтверждения, ваш email: {spoken}. Верно?',
    ar: 'للتأكيد، بريدك {spoken}. هل هذا صحيح؟',
    'ur-en': 'Just to confirm, I captured your email as {spoken}. Is that correct?',
    'hi-en': 'Just to confirm, I captured your email as {spoken}. Is that correct?',
  },
  payment_link_creating: {
    en: "One moment, I'm preparing your secure payment link.",
    ur: 'ایک لمحہ، میں آپ کا محفوظ پیمنٹ لنک تیار کر رہا ہوں۔',
    hi: 'एक क्षण, मैं आपका सुरक्षित पेमेंट लिंक तैयार कर रहा हूँ।',
    es: 'Un momento, estoy preparando su enlace de pago seguro.',
    ru: 'Один момент, готовлю безопасную ссылку для оплаты.',
    ar: 'لحظة، أجهز رابط الدفع الآمن.',
    'ur-en': "One moment, I'm preparing your secure payment link.",
    'hi-en': "One moment, I'm preparing your secure payment link.",
  },
  payment_email_sending: {
    en: "I'm sending that to your inbox now.",
    ur: 'میں ابھی آپ کے ان باکس میں بھیج رہا ہوں۔',
    hi: 'मैं अभी आपके इनबॉक्स में भेज रहा हूँ।',
    es: 'Lo estoy enviando a su bandeja de entrada.',
    ru: 'Отправляю на вашу почту.',
    ar: 'أرسله إلى بريدك الآن.',
    'ur-en': "I'm sending that to your inbox now.",
    'hi-en': "I'm sending that to your inbox now.",
  },
  payment_email_verifying: {
    en: 'Just checking that the email was accepted successfully.',
    ur: 'بس یہ دیکھ رہا ہوں کہ ای میل کامیابی سے قبول ہو گئی۔',
    hi: 'बस यह जाँच रहा हूँ कि ईमेल सफलतापूर्वक स्वीकार हुआ।',
    es: 'Comprobando que el correo se aceptó correctamente.',
    ru: 'Проверяю, что письмо принято.',
    ar: 'أتحقق من قبول البريد بنجاح.',
    'ur-en': 'Just checking that the email was accepted successfully.',
    'hi-en': 'Just checking that the email was accepted successfully.',
  },
  payment_email_success: {
    en: 'Your payment link has been sent successfully. Please check your inbox.',
    ur: 'آپ کا پیمنٹ لنک کامیابی سے بھیج دیا گیا۔ براہ کرم ان باکس چیک کریں۔',
    hi: 'आपका पेमेंट लिंक सफलतापूर्वक भेज दिया गया। कृपया इनबॉक्स देखें।',
    es: 'Su enlace de pago se envió correctamente. Revise su bandeja de entrada.',
    ru: 'Ссылка для оплаты отправлена. Проверьте почту.',
    ar: 'تم إرسال رابط الدفع بنجاح. يرجى التحقق من بريدك.',
    'ur-en': 'Your payment link has been sent successfully. Please check your inbox.',
    'hi-en': 'Your payment link has been sent successfully. Please check your inbox.',
  },
  payment_email_failure: {
    en: 'I apologize, there was an issue sending the payment link. Let me try again.',
    ur: 'معذرت، پیمنٹ لنک بھیجنے میں مسئلہ ہوا۔ میں دوبارہ کوشش کرتا ہوں۔',
    hi: 'क्षमा करें, पेमेंट लिंक भेजने में समस्या हुई। मैं फिर कोशिश करता हूँ।',
    es: 'Disculpe, hubo un problema al enviar el enlace. Lo intentaré de nuevo.',
    ru: 'Извините, не удалось отправить ссылку. Попробую снова.',
    ar: 'عذراً، حدثت مشكلة في إرسال الرابط. سأحاول مرة أخرى.',
    'ur-en': 'Sorry, payment link send issue. Let me try again.',
    'hi-en': 'Sorry, payment link send issue. Let me try again.',
  },
  post_payment_thanks: {
    en: "You're welcome. Thank you for your order.",
    ur: 'خوش آمدید۔ آپ کے آرڈر کا شکریہ۔',
    hi: 'आपका स्वागत है। आपके ऑर्डर के लिए धन्यवाद।',
    es: 'De nada. Gracias por su pedido.',
    ru: 'Пожалуйста. Спасибо за заказ.',
    ar: 'عفواً. شكراً لطلبك.',
    'ur-en': "You're welcome. Thank you for your order.",
    'hi-en': "You're welcome. Thank you for your order.",
  },
};

function normalizeBaseLanguage(code: string): CustomerLanguage {
  const c = code.trim().toLowerCase();
  if (c === 'ur' || c === 'hi' || c === 'es' || c === 'ru' || c === 'ar') return c;
  return 'en';
}

function detectMixedLanguage(text: string, base: CustomerLanguage): CustomerLanguage {
  const t = text.trim();
  if (!t) return base;
  const hasLatin = /[a-z]/i.test(t);
  const hasUrdu = /[ا-ے]/.test(t);
  const hasHindi = /[ऀ-ॿ]/.test(t);
  if (base === 'ur' && hasLatin && (hasUrdu || MIXED_UR_EN_MARKERS.test(t))) return 'ur-en';
  if (base === 'hi' && hasLatin && (hasHindi || MIXED_HI_EN_MARKERS.test(t))) return 'hi-en';
  if (hasUrdu && hasLatin) return 'ur-en';
  if (hasHindi && hasLatin) return 'hi-en';
  return base;
}

function isGreetingOnly(text: string): CustomerLanguage | null {
  const t = text.trim();
  for (const hint of GREETING_ONLY_PATTERNS) {
    if (hint.patterns.some((re) => re.test(t))) return hint.lang;
  }
  return null;
}

function isLatinDominantEnglishUtterance(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[ا-ے]/.test(t) || /[ء-ي]/.test(t) || /[ऀ-ॿ]/.test(t)) return false;
  if (!/[a-z]/i.test(t)) return false;
  return LATIN_ENGLISH_MARKERS.test(t) || /^[a-z0-9\s.,!?'"\-]+$/i.test(t);
}

export type ExplicitLanguageSwitchResult = {
  requested: CustomerLanguage | null;
  languageConfidenceScore: number;
  phrase: string | null;
};

/** Detect explicit "speak English", "Urdu mein bolo", etc. */
export function detectExplicitLanguageSwitch(text: string): ExplicitLanguageSwitchResult {
  const t = text.trim();
  if (!t) return { requested: null, languageConfidenceScore: 0, phrase: null };

  for (const row of EXPLICIT_LANGUAGE_SWITCH) {
    for (const pattern of row.patterns) {
      const m = t.match(pattern);
      if (m) {
        return {
          requested: row.lang,
          languageConfidenceScore: 0.99,
          phrase: m[0] ?? null,
        };
      }
    }
  }

  return { requested: null, languageConfidenceScore: 0, phrase: null };
}

export type PerTurnLanguageDetection = LanguageDetectionResult & {
  customerLanguage: CustomerLanguage;
  languageConfidenceScore: number;
};

/** Detect language on every customer turn (not only the first). */
export function detectLanguageEveryTurn(text: string): PerTurnLanguageDetection {
  const t = text.trim();
  const explicit = detectExplicitLanguageSwitch(text);
  if (explicit.requested) {
    const customerLanguage = detectMixedLanguage(text, explicit.requested);
    return {
      language: explicit.requested,
      confidence: explicit.languageConfidenceScore,
      customerLanguage,
      languageConfidenceScore: explicit.languageConfidenceScore,
    };
  }

  const greetingOnly = isGreetingOnly(text);
  if (greetingOnly) {
    const customerLanguage = detectMixedLanguage(text, greetingOnly);
    return {
      language: greetingOnly,
      confidence: 0.94,
      customerLanguage,
      languageConfidenceScore: 0.94,
    };
  }

  if (MIXED_UR_EN_MARKERS.test(t) && /\b(salam|ji|bhai|mujhe|chahiye)\b/i.test(t)) {
    const customerLanguage = detectMixedLanguage(text, 'ur');
    return {
      language: 'ur',
      confidence: 0.88,
      customerLanguage,
      languageConfidenceScore: 0.88,
    };
  }
  if (MIXED_HI_EN_MARKERS.test(t) && /\b(namaste|namaskar|mujhe|chahiye)\b/i.test(t)) {
    const customerLanguage = detectMixedLanguage(text, 'hi');
    return {
      language: 'hi',
      confidence: 0.88,
      customerLanguage,
      languageConfidenceScore: 0.88,
    };
  }

  if (isLatinDominantEnglishUtterance(text)) {
    const customerLanguage = detectMixedLanguage(text, 'en');
    return {
      language: 'en',
      confidence: 0.9,
      customerLanguage,
      languageConfidenceScore: 0.9,
    };
  }

  const detected = detectLanguageFromText(text);
  const base = normalizeBaseLanguage(detected.language);
  const customerLanguage = detectMixedLanguage(text, base);
  return {
    ...detected,
    language: base,
    customerLanguage,
    languageConfidenceScore: detected.confidence,
  };
}

/** @deprecated Use detectLanguageEveryTurn */
export function detectCustomerLanguage(text: string): PerTurnLanguageDetection {
  return detectLanguageEveryTurn(text);
}

export type SessionLanguageUpdate = {
  language: CustomerLanguage;
  switched: boolean;
  languageSwitchRequested: boolean;
  replyLanguageSelected: CustomerLanguage;
};

/**
 * Latest customer language overrides prior session language.
 * Explicit switch requests always win.
 */
export function updateSessionLanguage(
  previous: CustomerLanguage | null | undefined,
  turn: PerTurnLanguageDetection,
  explicitSwitch: ExplicitLanguageSwitchResult,
): SessionLanguageUpdate {
  const languageSwitchRequested = explicitSwitch.requested != null;
  const nextLanguage = languageSwitchRequested
    ? (explicitSwitch.requested as CustomerLanguage)
    : turn.customerLanguage;

  if (!previous) {
    return {
      language: nextLanguage,
      switched: false,
      languageSwitchRequested,
      replyLanguageSelected: nextLanguage,
    };
  }

  const switched = previous !== nextLanguage;
  return {
    language: nextLanguage,
    switched,
    languageSwitchRequested,
    replyLanguageSelected: nextLanguage,
  };
}

/** @deprecated Use updateSessionLanguage */
export function setSessionLanguage(
  sessionLanguage: CustomerLanguage | null | undefined,
  utteranceLanguage: CustomerLanguage,
  confidence: number,
): CustomerLanguage {
  const turn: PerTurnLanguageDetection = {
    language: utteranceLanguage,
    confidence,
    customerLanguage: utteranceLanguage,
    languageConfidenceScore: confidence,
  };
  return updateSessionLanguage(sessionLanguage, turn, { requested: null, languageConfidenceScore: 0, phrase: null })
    .language;
}

export function sessionLanguagePatch(language: CustomerLanguage): Record<string, string> {
  return { [SESSION_LANGUAGE_KEY]: language };
}

export function replyInCustomerLanguage(
  language: CustomerLanguage | null | undefined,
  messageType: CheckoutMessageType,
  vars?: { spoken?: string },
): string {
  const lang = language ?? 'en';
  const row = COPY[messageType][lang] ?? COPY[messageType].en;
  if (vars?.spoken) return row.replace('{spoken}', vars.spoken);
  return row;
}

export function buildLanguageSwitchAcknowledgment(language: CustomerLanguage): string {
  return replyInCustomerLanguage(language, 'language_switch_ack');
}

export function buildLanguageDetectedPerTurnLog(args: {
  callSessionId?: string;
  language: CustomerLanguage;
  confidence: number;
  previousLanguage?: CustomerLanguage | null;
}): Record<string, unknown> {
  return {
    event: 'language_detected_per_turn',
    ...(args.callSessionId ? { callSessionId: args.callSessionId } : {}),
    language: args.language,
    confidence: args.confidence,
    languageConfidenceScore: args.confidence,
    ...(args.previousLanguage ? { previousLanguage: args.previousLanguage } : {}),
  };
}

export function buildLanguageSwitchedLog(args: {
  callSessionId?: string;
  from: CustomerLanguage;
  to: CustomerLanguage;
}): Record<string, unknown> {
  return {
    event: 'language_switched',
    ...(args.callSessionId ? { callSessionId: args.callSessionId } : {}),
    from: args.from,
    to: args.to,
  };
}

export function buildLanguageSwitchRequestedLog(args: {
  callSessionId?: string;
  requested: CustomerLanguage;
  phrase?: string | null;
}): Record<string, unknown> {
  return {
    event: 'language_switch_requested',
    ...(args.callSessionId ? { callSessionId: args.callSessionId } : {}),
    requested: args.requested,
    ...(args.phrase ? { phrase: args.phrase } : {}),
  };
}

export function prependLanguageSwitchAcknowledgment(
  reply: string,
  ack: string | null,
  options: { switchRequested: boolean },
): string {
  if (!ack || !options.switchRequested) return reply;
  const trimmed = reply.trim();
  if (!trimmed) return ack;
  if (trimmed.startsWith(ack)) return trimmed;
  return `${ack} ${trimmed}`;
}

export function buildReplyLanguageSelectedLog(args: {
  callSessionId?: string;
  replyLanguage: CustomerLanguage;
}): Record<string, unknown> {
  return {
    event: 'reply_language_selected',
    ...(args.callSessionId ? { callSessionId: args.callSessionId } : {}),
    replyLanguage: args.replyLanguage,
  };
}

/** @deprecated */
export function buildLanguageDetectedLog(args: {
  callSessionId?: string;
  language: CustomerLanguage;
  confidence: number;
}): Record<string, unknown> {
  return buildLanguageDetectedPerTurnLog(args);
}
