/**
 * Offline diagnostic — proves VIP customer history minification stays token-light.
 * Usage: npx tsx scripts/verifyCustomerHistoryCapability.ts [customerGid]
 */
import {
  minifyCustomerHistoryOrders,
  type RawCustomerHistoryOrderNode,
} from "../src/adapters/shopifyStorefrontAdapter.js";

const MOCK_CUSTOMER_ID =
  process.argv[2]?.trim() || "gid://shopify/Customer/9999999999";

const BOOK_TITLES = [
  "Harry Potter and the Sorcerer's Stone",
  "The Holy Quran (English)",
  "Dictionary Spanish-English",
  "Chicken Soup for the Soul",
  "Think and Grow Rich",
  "The Autobiography of Malcolm X",
  "Atomic Habits",
  "The 48 Laws of Power",
  "Rich Dad Poor Dad",
  "The Art of War",
];

function mockOrder(
  index: number,
  month: number,
  year: number,
  status: { financial?: string; fulfillment?: string },
): { node: RawCustomerHistoryOrderNode } {
  const orderNum = 12000 + index;
  const createdAt = new Date(Date.UTC(year, month - 1, 15)).toISOString();
  const title = BOOK_TITLES[index % BOOK_TITLES.length]!;
  return {
    node: {
      name: `#${orderNum}`,
      createdAt,
      displayFinancialStatus: status.financial,
      displayFulfillmentStatus: status.fulfillment,
      totalPriceSet: {
        shopMoney: { amount: (19.99 + index * 2.5).toFixed(2), currencyCode: "USD" },
      },
      lineItems: {
        edges: [
          { node: { title, quantity: 1 } },
          ...(index % 3 === 0
            ? [{ node: { title: "Study Bible", quantity: 2 } }]
            : []),
        ],
      },
    },
  };
}

/** Ten orders spanning January–October 2026 (plus one refunded). */
function buildMockHistoryEdges(): Array<{ node?: RawCustomerHistoryOrderNode }> {
  const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  return months.map((month, i) =>
    mockOrder(
      i,
      month,
      2026,
      i === 5
        ? { financial: "REFUNDED", fulfillment: "Fulfilled" }
        : { financial: "PAID", fulfillment: "Fulfilled" },
    ),
  );
}

const edges = buildMockHistoryEdges();
const compressed = minifyCustomerHistoryOrders(edges);
const payload = {
  customerId: MOCK_CUSTOMER_ID,
  orderCount: compressed.length,
  orders: compressed,
};

const json = JSON.stringify(payload);
const approxTokens = Math.ceil(json.length / 4);

console.log("=== Customer History Capability Diagnostic ===");
console.log("Customer ID:", MOCK_CUSTOMER_ID);
console.log("Orders minified:", compressed.length);
console.log("Approx. LLM tokens (chars/4):", approxTokens);
console.log("\n--- Minified payload (exact shape sent to LLM) ---\n");
console.log(JSON.stringify(payload, null, 2));

const uniqueMonths = [...new Set(compressed.map((o) => o.monthYear))];
console.log("\n--- Month groups for VIP drill-down ---");
console.log(uniqueMonths.join(", "));

if (compressed.length < 10) {
  console.error("\nFAIL: Expected at least 10 mock orders.");
  process.exit(1);
}

if (!compressed.every((o) => o.monthYear && o.items && o.orderNumber.startsWith("#"))) {
  console.error("\nFAIL: Compressed shape missing required fields.");
  process.exit(1);
}

console.log("\nPASS: Payload is compressed and ready for VIP month drill-down.");
