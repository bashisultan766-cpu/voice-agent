/**
 * Order history flow — context memory, month drill-down, verified vs unverified speech.
 */
import type { CustomerHistoryOrderSummary } from "../adapters/shopifyStorefrontAdapter.js";
import type { CallSession } from "../types/order.js";

export interface OrderHistoryContext {
  active: boolean;
  orderCount: number;
  orders: CustomerHistoryOrderSummary[];
  /** Unique monthYear labels from Shopify (e.g. "June 2025"). */
  uniqueMonths: string[];
  /** Month token the caller last asked about (e.g. "June"). */
  selectedMonth?: string;
}

const MONTH_ALIASES: Record<string, string> = {
  january: "January",
  jan: "January",
  february: "February",
  feb: "February",
  march: "March",
  mar: "March",
  april: "April",
  apr: "April",
  may: "May",
  june: "June",
  jun: "June",
  july: "July",
  jul: "July",
  august: "August",
  aug: "August",
  september: "September",
  sept: "September",
  sep: "September",
  october: "October",
  oct: "October",
  november: "November",
  nov: "November",
  december: "December",
  dec: "December",
};

const MONTH_TOKEN_RE =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;

const MONTH_FOLLOWUP_RE =
  /\b(?:tell\s+me\s+about|what\s+about|give\s+me\s+details\s+(?:of|for|on)|what\s+did\s+i\s+order\s+in|orders?\s+in)\b/i;

export function parseMonthFromUtterance(text: string): string | null {
  const match = text.trim().match(MONTH_TOKEN_RE);
  if (!match) return null;
  return MONTH_ALIASES[match[1].toLowerCase()] ?? null;
}

export function isOrderHistoryContextActive(session?: CallSession): boolean {
  return session?.orderHistoryContext?.active === true;
}

export function setOrderHistoryContext(
  session: CallSession,
  orders: CustomerHistoryOrderSummary[],
  orderCount: number,
): OrderHistoryContext {
  const uniqueMonths = [...new Set(orders.map((o) => o.monthYear).filter(Boolean))];
  const ctx: OrderHistoryContext = {
    active: true,
    orderCount,
    orders,
    uniqueMonths,
  };
  session.orderHistoryContext = ctx;
  return ctx;
}

export function clearOrderHistoryContext(session: CallSession): void {
  session.orderHistoryContext = undefined;
}

export function selectMonthInHistoryContext(session: CallSession, monthToken: string): void {
  if (!session.orderHistoryContext) return;
  session.orderHistoryContext.selectedMonth = monthToken;
}

export function monthYearMatchesToken(monthYear: string, monthToken: string): boolean {
  return monthYear.toLowerCase().startsWith(monthToken.toLowerCase());
}

export function buildUnverifiedOrderHistorySpeech(orderCount: number): string {
  const count = Math.max(0, orderCount);
  if (count === 0) {
    return "I do not see any previous orders on file for this customer.";
  }
  const label = count === 1 ? "1 previous order" : `${count} previous orders`;
  return `This customer has ${label}, but I can only share detailed order history with a verified caller.`;
}

function spokenMonthLabels(monthYears: string[]): string {
  const labels = [...new Set(monthYears.map((m) => m.split(/\s+/)[0]).filter(Boolean))];
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export function buildVerifiedHistoryOverviewSpeech(ctx: OrderHistoryContext): string {
  const count = ctx.orderCount;
  const months = spokenMonthLabels(ctx.uniqueMonths);
  if (!months) {
    const label = count === 1 ? "1 past order" : `${count} past orders`;
    return `You have ${label} on file. Which one would you like to hear about?`;
  }
  const label = count === 1 ? "1 past order" : `${count} past orders`;
  return `You have ${label}. I see orders in ${months}. Which month would you like to hear about?`;
}

export function buildMonthDrillDownSpeech(
  ctx: OrderHistoryContext,
  monthToken: string,
): string | null {
  const matches = ctx.orders.filter((o) => monthYearMatchesToken(o.monthYear, monthToken));
  if (matches.length === 0) {
    return `I do not see any orders in ${monthToken} on file. Which other month would you like?`;
  }

  const parts = matches.map((order) => {
    const num = order.orderNumber.replace(/^#/, "");
    const items = String(order.items ?? "").trim() || "items on file";
    return `order ${num} from ${order.monthYear}: ${items}, total ${order.totalAmount}, status ${order.status}`;
  });

  if (parts.length === 1) {
    return `In ${monthToken}, you had ${parts[0]}. What detail would you like next — the total, items, or status?`;
  }
  return `In ${monthToken}, you had ${parts.length} orders. ${parts.join(". ")}. Which order should I go into?`;
}

export function isOrderHistoryMonthFollowUp(text: string, session?: CallSession): boolean {
  if (!isOrderHistoryContextActive(session)) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (parseMonthFromUtterance(trimmed)) return true;
  return MONTH_FOLLOWUP_RE.test(trimmed);
}

export function isOrderHistoryIntentUtterance(text: string, session?: CallSession): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\b(order\s+history|past\s+orders|previous\s+orders|my\s+other\s+orders)\b/i.test(trimmed)) {
    return true;
  }
  if (isOrderHistoryContextActive(session)) {
    return isOrderHistoryMonthFollowUp(trimmed, session);
  }
  if (/\b(?:tell\s+me\s+about|what\s+about|what\s+did\s+i\s+order\s+in|orders?\s+in)\b/i.test(trimmed)) {
    return parseMonthFromUtterance(trimmed) !== null;
  }
  return false;
}
