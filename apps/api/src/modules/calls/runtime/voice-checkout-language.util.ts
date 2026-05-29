/**
 * Multilingual voice checkout — detect session language and return deterministic copy.
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
  | 'product_checkout_intro';

const GREETING_HINTS: Array<{ lang: CustomerLanguage; patterns: RegExp[] }> = [
  {
    lang: 'ur',
    patterns: [
      /\bas[- ]?salamu?\s+alaikum\b/i,
      /\bsalam\b/i,
      /\bassalam\b/i,
      /\bkhuda\s+hafiz\b/i,
      /\bshukriya\b/i,
    ],
  },
  {
    lang: 'hi',
    patterns: [/\bnamaste\b/i, /\bnamaskar\b/i, /\bdhanyavaad\b/i, /\bshukriya\b/i],
  },
  { lang: 'es', patterns: [/\bhola\b/i, /\bgracias\b/i, /\bbuenos\s+dias\b/i] },
  { lang: 'ru', patterns: [/\bprivet\b/i, /\bпривет\b/i, /\bздравствуйте\b/i, /\bspasibo\b/i] },
  { lang: 'ar', patterns: [/\bmarhaba\b/i, /\bahlan\b/i, /\bsalaam\b/i] },
];

const MIXED_UR_EN_MARKERS = /\b(ji|bhai|aap|mujhe|chahiye|kitab|book|email|payment)\b/i;
const MIXED_HI_EN_MARKERS = /\b(ji|bhai|aap|mujhe|chahiye|kitab|book|email|payment)\b/i;

const COPY: Record<CheckoutMessageType, Record<CustomerLanguage, string>> = {
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
    'ur-en':
      'Please apna email address bata dein taake main payment link bhej sakoon.',
    'hi-en':
      'Please apna email address bataiye taaki main payment link bhej sakoon.',
  },
  email_invalid_slow_retry: {
    en: "I couldn't verify that email. Please repeat your email address slowly.",
    ur: 'میں اس ای میل کی تصدیق نہیں کر سکا۔ براہ کرم اپنا ای میل آہستہ دہرائیں۔',
    hi: 'मैं उस ईमेल की पुष्टि नहीं कर सका। कृपया अपना ईमेल धीरे-धीरे दोहराएँ।',
    es: 'No pude verificar ese correo. Por favor, repita su correo lentamente.',
    ru: 'Не удалось проверить этот адрес. Повторите email медленно.',
    ar: 'لم أتمكن من التحقق من البريد. يرجى تكرار بريدك ببطء.',
    'ur-en':
      "I couldn't verify that email. Please apna email slowly repeat karein.",
    'hi-en':
      "I couldn't verify that email. Please apna email slowly repeat kijiye.",
  },
  email_invalid_spell_retry: {
    en: 'I may have captured that incorrectly. Please spell your email address letter by letter.',
    ur: 'شاید میں نے غلط لکھ لیا۔ براہ کرم اپنا ای میل حرف بہ حرف بتائیں۔',
    hi: 'शायद मैंने गलत लिख लिया। कृपया अपना ईमेल अक्षर दर अक्षर बताएँ।',
    es: 'Puede que lo haya capturado mal. Deletree su correo letra por letra.',
    ru: 'Возможно, я записал неверно. Произнесите email по буквам.',
    ar: 'ربما سجلته خطأ. يرجى تهجئة بريدك حرفاً حرفاً.',
    'ur-en':
      'Shayad galat capture hua. Please email letter by letter spell karein.',
    'hi-en':
      'Shayad galat capture hua. Please email letter by letter spell kijiye.',
  },
  email_confirmation: {
    en: 'Just to confirm, I have your email as {spoken}. Is that correct?',
    ur: 'تصدیق کے لیے، آپ کا ای میل {spoken} ہے۔ کیا یہ درست ہے؟',
    hi: 'पुष्टि के लिए, आपका ईमेल {spoken} है। क्या यह सही है?',
    es: 'Para confirmar, su correo es {spoken}. ¿Es correcto?',
    ru: 'Для подтверждения, ваш email: {spoken}. Верно?',
    ar: 'للتأكيد، بريدك {spoken}. هل هذا صحيح؟',
    'ur-en': 'Just to confirm, I have your email as {spoken}. Is that correct?',
    'hi-en': 'Just to confirm, I have your email as {spoken}. Is that correct?',
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
    'ur-en':
      'Your payment link has been sent successfully. Please check your inbox.',
    'hi-en':
      'Your payment link has been sent successfully. Please check your inbox.',
  },
  payment_email_failure: {
    en: 'I apologize, there was an issue sending the payment link. Let me try again.',
    ur: 'معذرت، پیمنٹ لنک بھیجنے میں مسئلہ ہوا۔ میں دوبارہ کوشش کرتا ہوں۔',
    hi: 'क्षमा करें, पेमेंट लिंक भेजने में समस्या हुई। मैं फिर कोशिश करता हूँ।',
    es: 'Disculpe, hubo un problema al enviar el enlace. Lo intentaré de nuevo.',
    ru: 'Извините, не удалось отправить ссылку. Попробую снова.',
    ar: 'عذراً، حدثت مشكلة في إرسال الرابط. سأحاول مرة أخرى.',
    'ur-en':
      'Sorry, payment link send issue. Let me try again.',
    'hi-en':
      'Sorry, payment link send issue. Let me try again.',
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

/** Detect customer language from utterance (first message and every turn). */
export function detectCustomerLanguage(text: string): LanguageDetectionResult & {
  customerLanguage: CustomerLanguage;
} {
  const t = text.trim();
  if (!t) {
    return { language: 'en', confidence: 0, customerLanguage: 'en' };
  }

  for (const hint of GREETING_HINTS) {
    if (hint.patterns.some((re) => re.test(t))) {
      const customerLanguage = detectMixedLanguage(t, hint.lang);
      return { language: hint.lang, confidence: 0.94, customerLanguage };
    }
  }

  const detected = detectLanguageFromText(t);
  const base = normalizeBaseLanguage(detected.language);
  const customerLanguage = detectMixedLanguage(t, base);
  return { ...detected, language: base, customerLanguage };
}

/** Persist language on session metadata (sticky until caller clearly switches). */
export function setSessionLanguage(
  sessionLanguage: CustomerLanguage | null | undefined,
  utteranceLanguage: CustomerLanguage,
  confidence: number,
): CustomerLanguage {
  if (!sessionLanguage) return utteranceLanguage;
  if (sessionLanguage === utteranceLanguage) return sessionLanguage;
  if (confidence >= 0.9) return utteranceLanguage;
  return sessionLanguage;
}

export function sessionLanguagePatch(language: CustomerLanguage): Record<string, string> {
  return { [SESSION_LANGUAGE_KEY]: language };
}

/** Deterministic localized checkout copy. */
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

export function buildLanguageDetectedLog(args: {
  callSessionId?: string;
  language: CustomerLanguage;
  confidence: number;
}): Record<string, unknown> {
  return {
    event: 'language_detected',
    ...(args.callSessionId ? { callSessionId: args.callSessionId } : {}),
    language: args.language,
    confidence: args.confidence,
  };
}
