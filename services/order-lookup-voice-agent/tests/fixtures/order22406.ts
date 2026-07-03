/**
 * Real-world order fixture — #22406 (Blake Penfield, PayPal refund via timeline).
 */
export const ORDER_22406_GQL_NODE = {
  id: "gid://shopify/Order/22406",
  name: "#22406",
  createdAt: "2025-05-15T14:22:00Z",
  processedAt: "2025-05-28T16:45:00Z",
  updatedAt: "2025-05-28T16:45:00Z",
  email: "blake.penfield@example.com",
  note: null,
  displayFulfillmentStatus: "UNFULFILLED",
  displayFinancialStatus: "REFUNDED",
  customer: {
    firstName: "Blake",
    lastName: "Penfield",
    email: "blake.penfield@example.com",
  },
  subtotalPriceSet: { shopMoney: { amount: "42.00", currencyCode: "USD" } },
  totalPriceSet: { shopMoney: { amount: "47.00", currencyCode: "USD" } },
  totalShippingPriceSet: { shopMoney: { amount: "5.00", currencyCode: "USD" } },
  lineItems: {
    edges: [{ node: { title: "Prison Ramen: Recipes and Stories", quantity: 1 } }],
  },
  customAttributes: [],
  paymentGatewayNames: ["PayPal Express Checkout"],
  events: {
    edges: [
      {
        node: {
          message: "Reason: OUT OF STOCK - ISSUE REFUND VIA PAYPAL",
          action: "staff_comment",
          createdAt: "2025-05-28T15:00:00Z",
        },
      },
      {
        node: {
          message:
            "sent a refund notification email to Blake Penfield (btazp@yahoo.com) on May 28",
          action: "mail_sent",
          createdAt: "2025-05-28T16:45:00Z",
        },
      },
      {
        node: {
          message: "We successfully refunded $47.00 to PayPal Express Checkout.",
          action: "refund_success",
          createdAt: "2025-05-28T16:45:00Z",
        },
      },
    ],
  },
  refunds: [
    {
      note: "OUT OF STOCK",
      totalRefundedSet: { shopMoney: { amount: "47.00", currencyCode: "USD" } },
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

export const ORDER_22406_EXPECTED = {
  orderNumber: "#22406",
  customerName: "Blake Penfield",
  orderPlacedAt: "2025-05-15T14:22:00Z",
  subtotalAmount: "42.00 USD",
  totalAmount: "47.00 USD",
  shippingFee: "5.00 USD",
  lineItems: [{ title: "Prison Ramen: Recipes and Stories", quantity: 1 }],
  refundStatus: "REFUNDED",
  refundReason: "OUT OF STOCK - ISSUE REFUND VIA PAYPAL",
  refundAmount: "47.00 USD",
  refundNotificationEmail: "btazp@yahoo.com",
  refundDate: "May 28",
  paymentGateway: "PayPal Express Checkout",
} as const;
