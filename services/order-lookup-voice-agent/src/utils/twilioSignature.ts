import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

export async function validateTwilioSignature(
  req: Request,
  authToken: string,
  enabled: boolean,
  routerForwardSecret?: string,
): Promise<void> {
  if (routerForwardSecret && isRouterForwardRequest(req, routerForwardSecret)) {
    return;
  }

  if (!enabled) return;

  const signature = req.header("X-Twilio-Signature");
  if (!signature) {
    throw new Error("Missing Twilio signature");
  }

  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
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
    throw new Error("Invalid Twilio signature");
  }
}

export function isRouterForwardRequest(req: Request, secret: string): boolean {
  if (!secret) return false;
  const header = req.header("X-Voice-Router-Forward") ?? "";
  if (!header || header.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(secret));
}
