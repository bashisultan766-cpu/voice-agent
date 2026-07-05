/**
 * Real-world order fixture — #21796 (Jamaica Thompson, customer cancel refund).
 * Timeline: "Darren Herrington sent a refund notification email to Jamaica Thompson (jamaicathompson87@gmail.com)"
 * Reason: "Customer Cancel Order"
 */
export const ORDER_21796_GQL_NODE = {
  id: "gid://shopify/Order/21796",
  name: "#21796",
  createdAt: "2025-06-10T11:30:00Z",
  processedAt: "2025-06-12T09:15:00Z",
  updatedAt: "2025-06-12T09:15:00Z",
  email: "jamaica.billing@example.com",
  note: null,
  displayFulfillmentStatus: "UNFULFILLED",
  displayFinancialStatus: "REFUNDED",
  customer: {
    firstName: "Jamaica",
    lastName: "Thompson",
    email: "jamaica.billing@example.com",
  },
  subtotalPriceSet: { shopMoney: { amount: "35.00", currencyCode: "USD" } },
  totalPriceSet: { shopMoney: { amount: "40.00", currencyCode: "USD" } },
  totalShippingPriceSet: { shopMoney: { amount: "5.00", currencyCode: "USD" } },
  lineItems: {
    edges: [{ node: { title: "The 48 Laws of Power", quantity: 1 } }],
  },
  customAttributes: [],
  paymentGatewayNames: ["Shopify Payments"],
  events: {
    edges: [
      {
        node: {
          message:
            "Order confirmation email was sent to Jamaica Thompson (jamaicathompson87@gmail.com).",
          action: "mail_sent",
          createdAt: "2025-06-10T11:31:00Z",
        },
      },
      {
        node: {
          message: 'Reason: "Customer Cancel Order"',
          action: "comment",
          createdAt: "2025-06-12T09:10:00Z",
        },
      },
      {
        node: {
          message:
            "Darren Herrington sent a refund notification email to Jamaica Thompson (jamaicathompson87@gmail.com)",
          action: "mail_sent",
          createdAt: "2025-06-12T09:15:00Z",
        },
      },
      {
        node: {
          message: "We successfully refunded $40.00 USD.",
          action: "refund_success",
          createdAt: "2025-06-12T09:15:00Z",
        },
      },
    ],
  },
  refunds: [
    {
      note: "Customer Cancel Order",
      totalRefundedSet: { shopMoney: { amount: "40.00", currencyCode: "USD" } },
      transactions: [
        {
          gateway: "shopify_payments",
          formattedGateway: "Shopify Payments",
          paymentDetails: { company: "Visa", number: "4242" },
        },
      ],
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
          paymentDetails: { company: "Visa", number: "4242" },
        },
      },
    ],
  },
  fulfillments: [],
} as const;

export const ORDER_21796_EXPECTED = {
  orderNumber: "#21796",
  customerName: "Jamaica Thompson",
  customerEmail: "jamaica.billing@example.com",
  orderPlacedAt: "2025-06-10T11:30:00Z",
  refundStatus: "REFUNDED",
  refundReason: "Customer Cancel Order",
  refundNotificationEmail: "jamaicathompson87@gmail.com",
  orderConfirmationEmail: "jamaicathompson87@gmail.com",
  refundAmount: "40.00 USD",
} as const;
