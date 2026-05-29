export type OrderTurnIntent =
  | 'product_search'
  | 'product_confirmed'
  | 'variant_selected'
  | 'quantity_provided'
  | 'customer_name_provided'
  | 'email_provided'
  | 'order_confirmed'
  | 'cancel_order'
  | 'general_question';

import { extractEmailFromSpeech } from './voice-email-capture.util';

export type OrderTurnClassification = {
  intent: OrderTurnIntent;
  confidence: number;
  extracted?: {
    email?: string;
    quantity?: number;
    customerName?: string;
  };
  rawText?: string;
};

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

function extractEmail(text: string): string | null {
  return extractEmailFromSpeech(text);
}

function extractQuantity(text: string): number | null {
  const t = normalize(text);
  const m = t.match(/\b(\d{1,3})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(99, Math.trunc(n));
}

function hasAny(text: string, phrases: string[]): boolean {
  return phrases.some((p) => text.includes(p));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasToken(text: string, token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  const re = new RegExp(`(?:^|\\s|[\\.,!\\?;:()\\[\\]{}"'])${escapeRegex(t)}(?:$|\\s|[\\.,!\\?;:()\\[\\]{}"'])`, 'i');
  return re.test(text);
}

function hasAnyToken(text: string, tokens: string[]): boolean {
  return tokens.some((tok) => hasToken(text, tok));
}

export function classifyOrderTurn(text: string): OrderTurnClassification {
  const t = normalize(text);
  if (!t) return { intent: 'general_question', confidence: 0.2 };

  const base: Pick<OrderTurnClassification, 'rawText'> = { rawText: text };

  // cancel / change mind
  if (
    hasAny(t, [
      'cancel',
      'never mind',
      'nevermind',
      'stop',
      'forget it',
      'not interested',
      'annulla',
      'annullare',
      'lascia perdere',
      'отмена',
      'отменить',
      'не надо',
      'не хочу',
      'стоп',
    ])
  ) {
    return { ...base, intent: 'cancel_order', confidence: 0.95 };
  }

  // email provided
  const email = extractEmail(text);
  if (email) {
    return { ...base, intent: 'email_provided', confidence: 0.95, extracted: { email } };
  }

  // quantity
  const qty = extractQuantity(text);
  if (qty !== null && hasAny(t, ['qty', 'quantity', 'pieces', 'piece', 'x', 'times', 'quantita', 'quantità', 'pezzi', 'штук', 'количество'])) {
    return { ...base, intent: 'quantity_provided', confidence: 0.7, extracted: { quantity: qty } };
  }
  if (qty !== null && t.split(/\s+/).length <= 3) {
    // Avoid misclassifying size/color variants as quantity.
    if (hasAny(t, ['size', 'taglia', 'размер', 'color', 'colour', 'colore', 'цвет'])) {
      // fall through to variant selection
    } else {
    // "2 please" / "3" etc.
    return { ...base, intent: 'quantity_provided', confidence: 0.55, extracted: { quantity: qty } };
    }
  }

  // product confirmed / selection acknowledgement
  if (
    hasAny(t, [
      'that one',
      'this one',
      'the first one',
      'the second one',
      'top one',
      'yes that',
      "i'll take",
      'ill take',
      'order that',
      'add it',
      'want this one',
      'quello',
      'questo',
      'il primo',
      'il secondo',
      'тот',
      'этот',
      'первый',
      'второй',
    ])
  ) {
    return { ...base, intent: 'product_confirmed', confidence: 0.75 };
  }

  // order confirmed / yes (after product selection confirmation)
  if (
    hasAny(t, [
      'yes',
      'confirm',
      'place the order',
      'that is correct',
      'va bene',
      'confermo',
      'confermare',
      'perfetto',
      'подтверждаю',
      'оформляй',
      'оформить',
      'хорошо',
    ]) ||
    hasAnyToken(t, ['ok', 'okay', 'si', 'sì', 'да', 'ок'])
  ) {
    return { ...base, intent: 'order_confirmed', confidence: 0.75 };
  }

  // product search intent (place before variant: phrases like "Nike ... size 9" are still search)
  if (
    hasAny(t, [
      'do you have',
      'looking for',
      'i want',
      'i need',
      'buy',
      'price',
      'available',
      'in stock',
      'vorrei',
      'cerco',
      'quanto costa',
      'disponibile',
      'prezzo',
      'хочу',
      'купить',
      'сколько стоит',
      'есть в наличии',
      'цена',
    ]) ||
    (hasAny(t, ['size', 'taglia', 'размер']) &&
      /\b\d{1,3}\b/.test(t) &&
      t.split(/\s+/).length >= 3 &&
      !t.startsWith('size') &&
      !t.startsWith('taglia') &&
      !t.startsWith('размер'))
  ) {
    return { ...base, intent: 'product_search', confidence: 0.6 };
  }

  // variant selected (size/color/etc.)
  if (
    hasAny(t, [
      'size',
      'colour',
      'color',
      'variant',
      'small',
      'medium',
      'large',
      'xl',
      'xxl',
      'taglia',
      'colore',
      'variante',
      'размер',
      'цвет',
      'вариант',
    ])
  ) {
    return { ...base, intent: 'variant_selected', confidence: 0.55 };
  }

  // customer name provided (light heuristic)
  if (hasAny(t, ['my name is', "i'm ", 'this is ', 'sono ', 'mi chiamo', 'io sono', 'меня зовут', 'это '])) {
    const customerName = text.trim().slice(0, 80);
    return { ...base, intent: 'customer_name_provided', confidence: 0.55, extracted: { customerName } };
  }

  // default
  return { ...base, intent: 'general_question', confidence: 0.45 };
}
