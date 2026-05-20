export type ShopifyGraphqlErrorItem = {
  message: string;
  extensions?: Record<string, unknown>;
  locations?: unknown;
};

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 408 || status === 409 || (status >= 500 && status <= 599);
}

/** Top-level or partial GraphQL failure from Shopify Admin. */
export class ShopifyGraphqlError extends Error {
  readonly retryable: boolean;
  readonly status: number;
  readonly errors: ShopifyGraphqlErrorItem[];

  constructor(message: string, errors: ShopifyGraphqlErrorItem[], status: number) {
    super(message);
    this.name = 'ShopifyGraphqlError';
    const normalizedErrors = Array.isArray(errors) ? errors : [{ message: String(message || 'Shopify GraphQL error') }];
    this.errors = normalizedErrors;
    this.status = status;
    this.retryable =
      isRetryableHttpStatus(status) ||
      normalizedErrors.some((e) => {
        const code = (e.extensions?.code as string | undefined)?.toUpperCase();
        return code === 'THROTTLED' || code === 'INTERNAL_SERVER_ERROR';
      });
  }

  /** Short message safe to surface in logs or generic API errors. */
  summary(): string {
    return this.errors.map((e) => e.message).join('; ') || this.message;
  }
}

export class ShopifyRestError extends Error {
  readonly retryable: boolean;
  readonly status: number;
  readonly bodySnippet?: string;

  constructor(message: string, status: number, bodySnippet?: string) {
    super(message);
    this.name = 'ShopifyRestError';
    this.status = status;
    this.bodySnippet = bodySnippet;
    this.retryable = isRetryableHttpStatus(status);
  }
}

/** Business-rule failure before calling Shopify (e.g. variant not in cache). */
export class ShopifyCheckoutValidationError extends Error {
  readonly code: string;
  readonly retryable = false;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ShopifyCheckoutValidationError';
    this.code = code;
  }
}

export function isShopifyRetryableError(err: unknown): boolean {
  return err instanceof ShopifyGraphqlError
    ? err.retryable
    : err instanceof ShopifyRestError
      ? err.retryable
      : false;
}

export function formatShopifyErrorForCaller(err: unknown): string {
  if (err instanceof ShopifyCheckoutValidationError) return err.message;
  if (err instanceof ShopifyGraphqlError) {
    return err.retryable
      ? 'The store connection hit a temporary limit. Please try again in a moment.'
      : `Shopify could not complete that request: ${err.summary().slice(0, 200)}`;
  }
  if (err instanceof ShopifyRestError) {
    return err.retryable
      ? 'The store had a brief connection issue. Please try again shortly.'
      : `Shopify returned an error (${err.status}).`;
  }
  if (err instanceof Error) return err.message.slice(0, 300);
  return 'Shopify request failed.';
}
