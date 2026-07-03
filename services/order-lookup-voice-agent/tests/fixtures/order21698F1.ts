/**
 * Real-world order fixture — #21698-F1 (Joel Moore, PayPal refund).
 * Used to verify zero-hallucination field extraction from timeline events.
 */
export const ORDER_21698_F1_GQL_NODE = {
  id: "gid://shopify/Order/21698",
  name: "#21698-F1",
  createdAt: "2025-04-01T10:00:00Z",
  processedAt: "2025-04-05T10:00:00Z",
  updatedAt: "2025-04-05T10:00:00Z",
  email: "joel.moore@gmail.com",
  note: null,
  displayFulfillmentStatus: "UNFULFILLED",
  displayFinancialStatus: "REFUNDED",
  customer: {
    firstName: "Joel",
    lastName: "Moore",
    email: "joel.moore@gmail.com",
  },
  subtotalPriceSet: { shopMoney: { amount: "91.00", currencyCode: "USD" } },
  totalPriceSet: { shopMoney: { amount: "96.00", currencyCode: "USD" } },
  totalShippingPriceSet: { shopMoney: { amount: "5.00", currencyCode: "USD" } },
  lineItems: {
    edges: [{ node: { title: "The Holy Bible - King James Version", quantity: 1 } }],
  },
  customAttributes: [{ key: "refund_reason", value: "OUT OF STOCK" }],
  paymentGatewayNames: ["PayPal Express Checkout"],
  events: {
    edges: [
      {
        node: {
          message: "Refund notification was sent to zzyxx2002@yahoo.com.",
          action: "mail_sent",
        },
      },
      {
        node: {
          message: "We successfully refunded $96.00 to PayPal Express Checkout.",
          action: "refund_success",
        },
      },
    ],
  },
  refunds: [
    {
      note: "OUT OF STOCK",
      totalRefundedSet: { shopMoney: { amount: "96.00", currencyCode: "USD" } },
      transactions: [
        {
          gateway: "paypal",
          formattedGateway: "PayPal Express Checkout",
          paymentDetails: {},
        },
      ],
    },
  ],
  transactions: [
    {
      kind: "SALE",
      status: "SUCCESS",
      gateway: "paypal",
      formattedGateway: "PayPal Express Checkout",
      paymentDetails: {},
    },
  ],
  fulfillments: [],
} as const;

export const ORDER_21698_F1_EXPECTED = {
  orderNumber: "#21698-F1",
  customerName: "Joel Moore",
  customerEmail: "joel.moore@gmail.com",
  orderPlacedAt: "2025-04-01T10:00:00Z",
  totalAmount: "96.00 USD",
  shippingFee: "5.00 USD",
  subtotalAmount: "91.00 USD",
  lineItems: [{ title: "The Holy Bible - King James Version", quantity: 1 }],
  refundStatus: "REFUNDED",
  refundReason: "OUT OF STOCK",
  refundAmount: "96.00 USD",
  refundNotificationEmail: "zzyxx2002@yahoo.com",
  paymentGateway: "PayPal Express Checkout",
  cardLast4: undefined,
} as const;
