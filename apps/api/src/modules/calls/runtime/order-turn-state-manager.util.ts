import { normalizeOrderState, type OrderState } from './order-state-machine.util';
import type { OrderTurnClassification, OrderTurnIntent } from './order-intent-classifier.util';

export type OrderTurnUpdate = {
  nextState: OrderState;
  recoveryPrompt?: { key: RecoveryPromptKey };
};

export type RecoveryPromptKey =
  | 'UNCLEAR_PRODUCT'
  | 'INVALID_EMAIL'
  | 'CHANGED_MIND'
  | 'NEED_PRODUCT_FIRST'
  | 'CONFIRM_QUANTITY'
  | 'RESEND_PAYMENT_LINK';

export function applyTurnToOrderState(
  currentRaw: unknown,
  intent: OrderTurnIntent,
  cls: OrderTurnClassification,
): OrderTurnUpdate {
  const current = normalizeOrderState(currentRaw);
  const rawText = (cls as unknown as { rawText?: string }).rawText ?? '';
  const t = rawText.toLowerCase().trim();

  if (intent === 'cancel_order') {
    return { nextState: 'DONE', recoveryPrompt: { key: 'CHANGED_MIND' } };
  }

  if (intent === 'email_provided' && current === 'IDLE') {
    return { nextState: current, recoveryPrompt: { key: 'NEED_PRODUCT_FIRST' } };
  }

  switch (current) {
    case 'IDLE': {
      if (intent === 'product_search') return { nextState: 'PRODUCT_DISCOVERY' };
      return { nextState: 'IDLE' };
    }
    case 'PRODUCT_DISCOVERY': {
      if (intent === 'product_confirmed' || intent === 'order_confirmed') {
        return { nextState: 'EMAIL_COLLECTION' };
      }
      if (intent === 'email_provided') return { nextState: 'EMAIL_COLLECTION' };
      if (intent === 'product_search' || intent === 'variant_selected') {
        return { nextState: 'PRODUCT_DISCOVERY' };
      }
      if (intent === 'general_question') {
        const filler = t.length <= 6 && ['uh', 'uhm', 'um', 'hmm', 'okay', 'ok'].includes(t);
        if (filler || cls.confidence < 0.35) {
          return { nextState: 'PRODUCT_DISCOVERY', recoveryPrompt: { key: 'UNCLEAR_PRODUCT' } };
        }
        return { nextState: 'PRODUCT_DISCOVERY' };
      }
      return { nextState: 'PRODUCT_DISCOVERY', recoveryPrompt: { key: 'UNCLEAR_PRODUCT' } };
    }
    case 'EMAIL_COLLECTION': {
      if (intent === 'quantity_provided') {
        return { nextState: 'EMAIL_COLLECTION', recoveryPrompt: { key: 'CONFIRM_QUANTITY' } };
      }
      if (intent === 'email_provided') return { nextState: 'EMAIL_COLLECTION' };
      if (intent === 'general_question') {
        const wantsResend = /\b(resend|send again|didn't get|did not receive)\b/i.test(t);
        if (wantsResend) {
          return { nextState: 'EMAIL_COLLECTION', recoveryPrompt: { key: 'RESEND_PAYMENT_LINK' } };
        }
        const looksLikeQuestion =
          t.includes('?') || t.startsWith('what ') || t.startsWith('how ') || t.startsWith('when ');
        if (looksLikeQuestion) return { nextState: 'EMAIL_COLLECTION' };
        return { nextState: 'EMAIL_COLLECTION', recoveryPrompt: { key: 'INVALID_EMAIL' } };
      }
      if (intent === 'product_search') return { nextState: 'PRODUCT_DISCOVERY' };
      return { nextState: 'EMAIL_COLLECTION', recoveryPrompt: { key: 'INVALID_EMAIL' } };
    }
    case 'DONE': {
      return { nextState: 'DONE' };
    }
    default:
      return { nextState: normalizeOrderState(current) };
  }
}

export function recoveryPromptText(languageCode: string | null | undefined, key: RecoveryPromptKey): string {
  const lang = (languageCode ?? 'en').toLowerCase().trim();
  const L = (en: string, it?: string, ru?: string) => (lang === 'it' ? it ?? en : lang === 'ru' ? ru ?? en : en);
  switch (key) {
    case 'UNCLEAR_PRODUCT':
      return L(
        'Which book do you need? Tell me the title first.',
        'Puoi dirmi il titolo del libro o l’ISBN?',
        'Назовите название книги или ISBN, пожалуйста.',
      );
    case 'INVALID_EMAIL':
      return L(
        'Sorry, that did not sound like a full email—could you say it once more for me?',
        'Scusa, non mi è sembrata un’email completa—puoi ripeterla?',
        'Похоже, email получился неполным — повторите, пожалуйста?',
      );
    case 'CHANGED_MIND':
      return L(
        'No problem. If you want a book, tell me the title first.',
        'Nessun problema. Se vuoi un libro, dimmi il titolo o l’ISBN.',
        'Хорошо. Если нужна книга, назовите название или ISBN.',
      );
    case 'NEED_PRODUCT_FIRST':
      return L(
        'Sure. Tell me the book title first.',
        'Quale libro cerchi—titolo o ISBN?',
        'Какую книгу ищем—название или ISBN?',
      );
    case 'CONFIRM_QUANTITY':
      return L(
        'Got it. How many copies should I put on the checkout link?',
        'Perfetto. Quante copie vuoi?',
        'Сколько экземпляров добавить в заказ?',
      );
    case 'RESEND_PAYMENT_LINK':
      return L(
        'I can resend the checkout link—what email should I use?',
        'Posso reinviare il link—quale email uso?',
        'Могу отправить ссылку снова — какой email?',
      );
    default:
      return L('Could you repeat that?', 'Puoi ripetere?', 'Повторите, пожалуйста.');
  }
}
