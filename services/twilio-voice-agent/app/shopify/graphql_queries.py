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
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        email
        phone
        customer {
          firstName
          lastName
          email
          numberOfOrders
        }
        subtotalPriceSet {
          shopMoney { amount currencyCode }
        }
        totalShippingPriceSet {
          shopMoney { amount currencyCode }
        }
        totalTaxSet {
          shopMoney { amount currencyCode }
        }
        totalDiscountsSet {
          shopMoney { amount currencyCode }
        }
        totalPriceSet {
          shopMoney { amount currencyCode }
        }
        lineItems(first: 20) {
          edges {
            node {
              title
              quantity
              sku
              originalUnitPriceSet {
                shopMoney { amount currencyCode }
              }
              variant {
                barcode
                sku
              }
            }
          }
        }
        fulfillments(first: 3) {
          status
          trackingInfo {
            company
            number
            url
          }
        }
        refunds(first: 5) {
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
                lineItem { title }
              }
            }
          }
          transactions(first: 3) {
            edges {
              node {
                gateway
                status
                paymentDetails {
                  ... on CardPaymentDetails {
                    number
                    company
                  }
                }
              }
            }
          }
        }
        transactions(first: 5) {
          gateway
          status
          paymentDetails {
            ... on CardPaymentDetails {
              number
              company
            }
          }
        }
        cancelledAt
        canMarkAsPaid
        note
        tags
        customAttributes {
          key
          value
        }
        shippingAddress {
          name
          company
          address1
          address2
          city
          provinceCode
          zip
          countryCode
        }
        billingAddress {
          name
          city
          provinceCode
          countryCode
        }
      }
    }
  }
}
"""

GET_ORDER_TIMELINE = """
query GetOrderTimeline($id: ID!) {
  order(id: $id) {
    id
    hasTimelineComment
    events(first: 15, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          __typename
          createdAt
          ... on BasicEvent {
            message
          }
          ... on CommentEvent {
            message
            author {
              __typename
              ... on StaffMember {
                name
              }
            }
          }
        }
      }
    }
  }
}
"""

SEARCH_CUSTOMERS = """
query SearchCustomers($query: String!, $first: Int!) {
  customers(first: $first, query: $query) {
    edges {
      node {
        id
        firstName
        lastName
        phone
        email
        numberOfOrders
        defaultAddress { phone }
        orders(first: 3, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              name
              displayFinancialStatus
              displayFulfillmentStatus
              createdAt
            }
          }
        }
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
          productType
          onlineStoreUrl
          tags
          featuredImage {
            url
          }
          metafields(first: 10) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
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
    email
    customer {
      firstName
      lastName
      email
    }
    cancelledAt
    note
    tags
    totalShippingPriceSet {
      shopMoney { amount currencyCode }
    }
    transactions(first: 5) {
      gateway
      status
      paymentDetails {
        ... on CardPaymentDetails {
          number
          company
        }
      }
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
      transactions(first: 3) {
        edges {
          node {
            gateway
            status
            paymentDetails {
              ... on CardPaymentDetails {
                number
                company
              }
            }
          }
        }
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

CATALOG_SCAN_PRODUCT_FIELDS = """
  id
  title
  handle
  status
  productType
  vendor
  tags
  onlineStoreUrl
  publishedAt
  totalInventory
  resourcePublicationsV2(first: 5) {
    edges {
      node {
        isPublished
        publication { name id }
      }
    }
  }
  metafields(first: 10) {
    edges {
      node {
        namespace
        key
        value
        type
      }
    }
  }
  variants(first: 10) {
    edges {
      node {
        id
        title
        sku
        barcode
        price
        inventoryQuantity
        availableForSale
        inventoryPolicy
      }
    }
  }
"""

CATALOG_SCAN_PRODUCTS = f"""
query CatalogScanProducts($query: String!, $first: Int!) {{
  products(first: $first, query: $query) {{
    edges {{
      node {{
        {CATALOG_SCAN_PRODUCT_FIELDS}
      }}
    }}
  }}
}}
"""

CATALOG_SCAN_VARIANTS = """
query CatalogScanVariants($query: String!, $first: Int!) {
  productVariants(first: $first, query: $query) {
    edges {
      node {
        id
        title
        sku
        barcode
        price
        inventoryQuantity
        availableForSale
        inventoryPolicy
        product {
          id
          title
          handle
          status
          productType
          vendor
          tags
          onlineStoreUrl
          publishedAt
        }
      }
    }
  }
}
"""

LIST_COLLECTIONS = """
query ListCollections($first: Int!) {
  collections(first: $first) {
    edges {
      node {
        id
        title
        handle
      }
    }
  }
}
"""

COLLECTION_PRODUCTS = """
query CollectionProducts($id: ID!, $first: Int!) {
  collection(id: $id) {
    id
    title
    handle
    products(first: $first) {
      edges {
        node {
          id
          title
          handle
          status
          productType
          vendor
          tags
          onlineStoreUrl
          publishedAt
          variants(first: 5) {
            edges {
              node {
                id
                title
                sku
                price
                availableForSale
                inventoryQuantity
              }
            }
          }
        }
      }
    }
  }
}
"""
