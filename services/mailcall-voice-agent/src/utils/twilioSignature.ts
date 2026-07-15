import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

/**
 * Validate Twilio webhook signature against PUBLIC_BASE_URL + path
 * so TLS termination at a reverse proxy still matches.
 */
export function validateTwilioSignature(
  req: Request,
  authToken: string,
  enabled: boolean,
  publicBaseUrl?: string,
): void {
  if (!enabled) return;
  if (!authToken) {
    throw new Error("MAILCALL_TWILIO_AUTH_TOKEN required when signature validation is enabled");
  }

  const signature = req.header("X-Twilio-Signature");
  if (!signature) {
    throw new Error("Missing Twilio signature");
  }

  const url = buildSignedUrl(req, publicBaseUrl);
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
