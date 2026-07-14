/**
 * Durable note & ledger parser — extracts deposit / order total / credit balance
 * from Shopify order.note and customAttributes for proactive voice disclosure.
 */

export interface ParsedCustomerBalance {
  creditBalance?: number;
  deposit?: number;
  totalOrder?: number;
  rawNoteSnippet?: string;
}

const MONEY_RE = /\$?\s*([\d,]+(?:\.\d{1,2})?)/g;
const LEDGER_HINT_RE = /\b(balance|credit|deposit|refund|account\s+deposit|current\s+credit)\b/i;

function parseMoneyTokens(text: string): number[] {
  const amounts: number[] = [];
  const re = new RegExp(MONEY_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n)) amounts.push(n);
  }
  return amounts;
}

function pickLabeledAmount(text: string, labels: RegExp): number | undefined {
  const m = text.match(labels);
  if (!m?.[1]) return undefined;
  const n = Number(String(m[1]).replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse ledger-style notes such as:
 * "Account Deposit $65.00 - Total Order $40.00 = Current Credit Balance $25.00"
 */
export function parseCustomerLedgerNote(
  note?: string | null,
  customAttributes?: Array<{ key: string; value: string }> | null,
): ParsedCustomerBalance | null {
  const attrText = (customAttributes ?? [])
    .map((a) => `${a.key}: ${a.value}`)
    .join(" | ");
  const combined = [note ?? "", attrText].map((s) => s.trim()).filter(Boolean).join("\n");
  if (!combined || !LEDGER_HINT_RE.test(combined)) return null;

  const deposit =
    pickLabeledAmount(
      combined,
      /(?:account\s+)?deposit[^$\d]{0,20}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    ) ?? undefined;
  const totalOrder =
    pickLabeledAmount(
      combined,
      /(?:total\s+order|order\s+total)[^$\d]{0,20}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    ) ?? undefined;
  const creditBalance =
    pickLabeledAmount(
      combined,
      /(?:current\s+)?(?:credit\s+)?balance[^$\d]{0,20}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    ) ?? undefined;

  const amounts = parseMoneyTokens(combined);
  const resolved: ParsedCustomerBalance = {
    deposit: deposit ?? (amounts.length >= 1 ? amounts[0] : undefined),
    totalOrder: totalOrder ?? (amounts.length >= 2 ? amounts[1] : undefined),
    creditBalance:
      creditBalance ??
      (amounts.length >= 3
        ? amounts[2]
        : deposit != null && totalOrder != null
          ? Math.max(0, Number((deposit - totalOrder).toFixed(2)))
          : undefined),
    rawNoteSnippet: combined.slice(0, 240),
  };

  if (
    resolved.creditBalance == null &&
    resolved.deposit == null &&
    resolved.totalOrder == null
  ) {
    return null;
  }
  return resolved;
}

export function formatCreditBalanceSpeech(balance: ParsedCustomerBalance): string | null {
  if (balance.creditBalance == null || !Number.isFinite(balance.creditBalance)) return null;
  const dollars = balance.creditBalance.toFixed(2);
  return `I see you have a remaining credit balance of $${dollars} on your account.`;
}

export const LedgerNoteParser = {
  parse: parseCustomerLedgerNote,
  formatSpeech: formatCreditBalanceSpeech,
} as const;
