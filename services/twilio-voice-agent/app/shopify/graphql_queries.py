"""
Shopify Admin GraphQL query/mutation strings.

All queries target the Admin API version configured in SHOPIFY_API_VERSION.
"""

SEARCH_PRODUCTS = """
query SearchProducts($query: String!, $first: Int!) {
  products(first: $first, query: $query) {
    edges {
      node {
        id
        title
        handle
        onlineStoreUrl
        variants(first: 5) {
          edges {
            node {
              id
              title
              price
              inventoryQuantity
              availableForSale
            }
          }
        }
      }
    }
  }
}
"""

GET_PRODUCT_BY_ID = """
query GetProductById($id: ID!) {
  product(id: $id) {
    id
    title
    handle
    description
    onlineStoreUrl
    variants(first: 10) {
      edges {
        node {
          id
          title
          price
          inventoryQuantity
          availableForSale
        }
      }
    }
  }
}
"""

GET_PRODUCT_BY_HANDLE = """
query GetProductByHandle($handle: String!) {
  productByHandle(handle: $handle) {
    id
    title
    handle
    description
    onlineStoreUrl
    variants(first: 10) {
      edges {
        node {
          id
          title
          price
          inventoryQuantity
          availableForSale
        }
      }
    }
  }
}
"""

LOOKUP_ORDERS = """
query LookupOrders($query: String!, $first: Int!) {
  orders(first: $first, query: $query) {
    edges {
      node {
        id
        name
        displayFinancialStatus
        displayFulfillmentStatus
        email
        phone
        subtotalPriceSet {
          shopMoney { amount currencyCode }
        }
        totalShippingPriceSet {
          shopMoney { amount currencyCode }
        }
        lineItems(first: 10) {
          edges {
            node {
              title
              quantity
            }
          }
        }
        fulfillments(first: 1) {
          trackingInfo { number url }
        }
        cancelledAt
        canMarkAsPaid
      }
    }
  }
}
"""

SEARCH_VARIANTS_BY_BARCODE = """
query SearchVariantsByBarcode($barcode: String!, $first: Int!) {
  productVariants(first: $first, query: $barcode) {
    edges {
      node {
        id
        barcode
        sku
        price
        availableForSale
        inventoryQuantity
        title
        product {
          id
          title
          handle
          onlineStoreUrl
          tags
        }
      }
    }
  }
}
"""

GET_PRODUCT_METAFIELDS = """
query GetProductMetafields($id: ID!, $first: Int!, $namespace: String!) {
  product(id: $id) {
    id
    metafields(first: $first, namespace: $namespace) {
      edges {
        node {
          namespace
          key
          value
          type
        }
      }
    }
  }
}
"""

GET_ORDER_WITH_REFUNDS = """
query GetOrderWithRefunds($id: ID!) {
  order(id: $id) {
    id
    name
    displayFinancialStatus
    displayFulfillmentStatus
    cancelledAt
    note
    tags
    totalShippingPriceSet {
      shopMoney { amount currencyCode }
    }
    refunds {
      id
      createdAt
      note
      totalRefundedSet {
        shopMoney { amount currencyCode }
      }
      refundLineItems(first: 10) {
        edges {
          node {
            quantity
            subtotalSet {
              shopMoney { amount currencyCode }
            }
            lineItem {
              title
              originalUnitPriceSet {
                shopMoney { amount currencyCode }
              }
            }
          }
        }
      }
      orderAdjustments(first: 5) {
        kind
        amountSet { shopMoney { amount currencyCode } }
      }
    }
  }
}
"""

CREATE_DRAFT_ORDER = """
mutation CreateDraftOrder($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder {
      id
      name
      invoiceUrl
      status
    }
    userErrors {
      field
      message
    }
  }
}
"""
