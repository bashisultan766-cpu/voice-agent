/** Minimal Admin GraphQL product search for sub-second voice responses. */
export const VOICE_CATALOG_SEARCH_QUERY = `
  query VoiceCatalogSearch($first: Int!, $query: String!) {
    products(first: $first, query: $query) {
      nodes {
        id
        title
        featuredImage {
          url
        }
        variants(first: 8) {
          edges {
            node {
              id
              sku
              barcode
              price
              inventoryQuantity
              availableForSale
            }
          }
        }
      }
    }
  }
`;
