/** Result of a connection test. Returned by all connection test services. */
export interface ConnectionTestResult {
  success: boolean;
  message: string;
  /** Optional shop info on success (Shopify). */
  shop?: { name?: string; domain?: string; email?: string };
  /** Optional error code on failure (e.g. INVALID_TOKEN_OR_DOMAIN). */
  code?: string;
  /** Non-fatal notices (e.g. sender domain not verified in Resend). */
  warnings?: string[];
}
