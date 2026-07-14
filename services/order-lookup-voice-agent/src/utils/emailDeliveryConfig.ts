/**
 * Config-only helpers around email delivery availability.
 * Reading these does NOT import Resend or hit the network — safe for
 * ActionGateway / SupportCaseService / architecture invariants to consume.
 */
import { getConfig } from "../config.js";

/** True when Resend credentials are configured; false in test/dev without an API key. */
export function isEmailDeliveryConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.RESEND_API_KEY && cfg.RESEND_FROM_EMAIL);
}
