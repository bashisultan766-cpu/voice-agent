/**
 * Mock Shopify deep-fetch GraphQL response — all fields for proactive TTS template.
 */
import type { DeepOrderGraphqlNode } from "../../src/utils/orderDataParser.js";

export const DEEP_FETCH_GQL_NODE: DeepOrderGraphqlNode = {
  id: "gid://shopify/Order/18420",
  name: "#18420",
  createdAt: "2022-05-27T10:15:00Z",
  processedAt: "2022-06-02T14:00:00Z",
  updatedAt: "2022-06-02T14:00:00Z",
  email: "sarah.chen@outlook.com",
  note: null,
  displayFulfillmentStatus: "UNFULFILLED",
  displayFinancialStatus: "REFUNDED",
  customer: {
    firstName: "Sarah",
    lastName: "Chen",
    email: "sarah.chen@outlook.com",
  },
  currentSubtotalPriceSet: { shopMoney: { amount: "28.00", currencyCode: "USD" } },
  subtotalPriceSet: { shopMoney: { amount: "28.00", currencyCode: "USD" } },
  totalPriceSet: { shopMoney: { amount: "33.50", currencyCode: "USD" } },
  totalShippingPriceSet: { shopMoney: { amount: "5.50", currencyCode: "USD" } },
  lineItems: {
    edges: [
      {
        node: {
          title: "The Autobiography of Malcolm X",
          quantity: 1,
          originalUnitPriceSet: { shopMoney: { amount: "14.00", currencyCode: "USD" } },
        },
      },
      {
        node: {
          title: "Native Son",
          quantity: 1,
          originalUnitPriceSet: { shopMoney: { amount: "14.00", currencyCode: "USD" } },
        },
      },
    ],
  },
  customAttributes: [],
  paymentGatewayNames: ["Shopify Payments"],
  events: {
    edges: [
      {
        node: {
          message: "Reason: CUSTOMER REQUESTED CANCELLATION",
          action: "staff_comment",
          createdAt: "2022-06-01T12:00:00Z",
        },
      },
      {
        node: {
          message:
            "sent a refund notification email to Sarah Chen (sarah.refund@yahoo.com) on June 2",
          action: "mail_sent",
          createdAt: "2022-06-02T14:00:00Z",
        },
      },
    ],
  },
  refunds: [
    {
      note: "CUSTOMER REQUESTED CANCELLATION",
      totalRefundedSet: { shopMoney: { amount: "33.50", currencyCode: "USD" } },
    },
  ],
  transactions: {
    edges: [
      {
        node: {
          kind: "SALE",
          status: "SUCCESS",
          gateway: "shopify_payments",
          formattedGateway: "Shopify Payments",
          paymentDetails: { company: "Visa", number: "•••• 4242" },
        },
      },
    ],
  },
  fulfillments: [],
};

/** Exact fluent-English proactive summary for DEEP_FETCH_GQL_NODE. */
export const DEEP_FETCH_EXPECTED_TTS =
  "I found the order for Sarah Chen, placed on May 27th, 2022. " +
  "The email associated with this account is sarah.chen@outlook.com. " +
  "Your order contains 2 items. " +
  "The books cost 28 dollars and shipping was 5 dollars and 50 cents, making the total 33 dollars and 50 cents. " +
  "This order was refunded because CUSTOMER REQUESTED CANCELLATION. " +
  "A refund confirmation email was sent to sarah.refund@yahoo.com.";
