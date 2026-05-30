/**
 * Staging safety for real client-demo flows: approved emails only, no live card charges in test mode.
 */

export function isClientDemoStaging(): boolean {
  if (process.env.CLIENT_DEMO_STAGING_MODE === 'true') return true;
  if (process.env.CLIENT_DEMO_STAGING_MODE === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

export function isProductionCheckout(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.CLIENT_DEMO_STAGING_MODE !== 'true';
}

export function parseClientDemoEmailAllowlist(): Set<string> {
  const raw = process.env.CLIENT_DEMO_EMAIL_ALLOWLIST?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@')),
  );
}

/**
 * When allowlist env is set, only those recipients may receive payment emails (staging/demo).
 * Production callers are unaffected unless CLIENT_DEMO_EMAIL_ALLOWLIST is explicitly set.
 */
export function assertPaymentEmailRecipientAllowed(to: string): void {
  const allowlist = parseClientDemoEmailAllowlist();
  if (allowlist.size === 0) return;

  const normalized = to.trim().toLowerCase();
  if (!allowlist.has(normalized)) {
    throw new Error(
      `Payment email blocked: recipient is not in CLIENT_DEMO_EMAIL_ALLOWLIST. ` +
        `Approved: ${[...allowlist].join(', ')}`,
    );
  }
}

export function buildPaymentSafetyChecks(): {
  pass: boolean;
  stagingMode: boolean;
  productionMode: boolean;
  emailAllowlistConfigured: boolean;
  shopifyTestCheckoutRequired: boolean;
  realCardBlockedInStaging: boolean;
  checks: Array<{ key: string; pass: boolean; details: string; fix?: string }>;
} {
  const stagingMode = isClientDemoStaging();
  const productionMode = isProductionCheckout();
  const allowlist = parseClientDemoEmailAllowlist();
  const emailAllowlistConfigured = allowlist.size > 0;
  const shopifyTestCheckoutRequired =
    stagingMode && process.env.CLIENT_DEMO_REQUIRE_SHOPIFY_TEST_GATEWAY !== 'false';
  const realCardBlockedInStaging = stagingMode;

  const checks = [
    {
      key: 'staging_mode_declared',
      pass: stagingMode || productionMode,
      details: stagingMode
        ? 'Staging/demo mode (use Shopify test payments; no real card charges during automated tests).'
        : 'Production checkout mode — real Shopify checkout only.',
    },
    {
      key: 'email_allowlist_when_staging',
      pass: !stagingMode || emailAllowlistConfigured,
      details: emailAllowlistConfigured
        ? `${allowlist.size} approved recipient(s) in CLIENT_DEMO_EMAIL_ALLOWLIST`
        : 'CLIENT_DEMO_EMAIL_ALLOWLIST not set',
      fix: stagingMode
        ? 'Set CLIENT_DEMO_EMAIL_ALLOWLIST to comma-separated test inboxes (e.g. you@company.com).'
        : undefined,
    },
    {
      key: 'no_automated_real_payment_in_staging',
      pass: !stagingMode || realCardBlockedInStaging,
      details: stagingMode
        ? 'Automated demo scripts never complete a real card payment; use Shopify test gateway on the staging store.'
        : 'Production — payment completion is customer-driven on Shopify checkout.',
    },
    {
      key: 'live_call_test_mode',
      pass:
        process.env.LIVE_CALL_TEST_MODE !== 'true' ||
        Boolean(process.env.PUBLIC_WEBHOOK_BASE_URL?.trim()),
      details: `LIVE_CALL_TEST_MODE=${process.env.LIVE_CALL_TEST_MODE ?? 'false'}`,
      fix:
        process.env.LIVE_CALL_TEST_MODE === 'true'
          ? 'Set PUBLIC_WEBHOOK_BASE_URL to your public HTTPS API origin before live calls.'
          : undefined,
    },
  ];

  const pass = checks.every((c) => c.pass);
  return {
    pass,
    stagingMode,
    productionMode,
    emailAllowlistConfigured,
    shopifyTestCheckoutRequired,
    realCardBlockedInStaging,
    checks,
  };
}
