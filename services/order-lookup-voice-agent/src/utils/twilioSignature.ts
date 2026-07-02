import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

/**
 * Validate Twilio webhook signature.
 * Uses PUBLIC_BASE_URL + path (same as Python agent) so nginx TLS termination matches.
 */
export async function validateTwilioSignature(
  req: Request,
  authToken: string,
  enabled: boolean,
  options?: {
    routerForwardSecret?: string;
    publicBaseUrl?: string;
  },
): Promise<void> {
  if (options?.routerForwardSecret && isRouterForwardRequest(req, options.routerForwardSecret)) {
    return;
  }

  if (!enabled) return;

  const signature = req.header("X-Twilio-Signature");
  if (!signature) {
    throw new Error("Missing Twilio signature");
  }

  const url = buildSignedUrl(req, options?.publicBaseUrl);
  const params = req.body as Record<string, string>;
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + String(params[key] ?? "");
  }

  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  const valid =
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

  if (!valid) {
    throw new Error(`Invalid Twilio signature for url=${url}`);
  }
}

function buildSignedUrl(req: Request, publicBaseUrl?: string): string {
  if (publicBaseUrl) {
    const base = publicBaseUrl.replace(/\/$/, "");
    return `${base}${req.originalUrl}`;
  }

  const proto = req.header("x-forwarded-proto") ?? req.protocol;
  const host = req.header("x-forwarded-host") ?? req.get("host");
  return `${proto}://${host}${req.originalUrl}`;
}

export function isRouterForwardRequest(req: Request, secret: string): boolean {
  if (!secret) return false;
  const header = req.header("X-Voice-Router-Forward") ?? "";
  if (!header || header.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(secret));
}
