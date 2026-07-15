import { createHmac, timingSafeEqual } from "node:crypto";
import querystring from "node:querystring";
import type { Request } from "express";

/**
 * Validate Twilio webhook signature behind Nginx TLS termination.
 *
 * Twilio signs: full absolute URL (https://host/path) + sorted POST fields
 * (key + value concatenated). We rebuild that using:
 *  - public HTTPS base (not the internal http://127.0.0.1:8010 URL)
 *  - params parsed from req.rawBody when available (unmutated form body)
 *  - multiple URL candidates (trailing slash / proto) for proxy edge cases
 */
export function validateTwilioSignature(
  req: Request,
  authToken: string,
  enabled: boolean,
  publicBaseUrl?: string,
): void {
  if (!enabled) return;

  const token = authToken.replace(/\s+/g, "").trim();
  if (!token) {
    throw new Error("MAILCALL_TWILIO_AUTH_TOKEN required when signature validation is enabled");
  }

  const signature = req.header("X-Twilio-Signature");
  if (!signature) {
    throw new Error("Missing Twilio signature");
  }

  const params = extractFormParams(req);
  const urlCandidates = buildSignedUrlCandidates(req, publicBaseUrl);

  for (const url of urlCandidates) {
    if (signatureMatches(token, signature, url, params)) {
      return;
    }
  }

  throw new Error(`Invalid Twilio signature for url=${urlCandidates[0]}`);
}

function extractFormParams(req: Request): Record<string, string> {
  // Prefer exact bytes captured in the body-parser verify hook.
  if (req.rawBody && req.rawBody.length > 0) {
    const parsed = querystring.parse(req.rawBody.toString("utf8"));
    return flattenParams(parsed);
  }

  return flattenParams((req.body ?? {}) as Record<string, unknown>);
}

function flattenParams(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null) {
      out[key] = "";
      continue;
    }
    if (Array.isArray(value)) {
      // Twilio voice webhooks are single-valued; join matches common SDK behavior.
      out[key] = value.map((v) => String(v)).join("");
      continue;
    }
    out[key] = String(value);
  }
  return out;
}

function signatureMatches(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + (params[key] ?? "");
  }

  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Generate absolute URL variants Twilio may have used when computing X-Twilio-Signature.
 */
export function buildSignedUrlCandidates(req: Request, publicBaseUrl?: string): string[] {
  const path = req.originalUrl || req.url || "";
  const bases: string[] = [];

  if (publicBaseUrl) {
    bases.push(publicBaseUrl.replace(/\/$/, ""));
  }

  const protoHeader = String(req.header("x-forwarded-proto") ?? "")
    .split(",")[0]!
    .trim();
  const hostHeader = String(req.header("x-forwarded-host") ?? req.get("host") ?? "")
    .split(",")[0]!
    .trim();

  if (hostHeader) {
    const proto = protoHeader || (req.protocol === "http" ? "http" : "https");
    bases.push(`${proto}://${hostHeader}`.replace(/\/$/, ""));
    // Classic mismatch: proxy internal is http but Twilio signed https
    if (proto !== "https") {
      bases.push(`https://${hostHeader}`);
    }
    if (proto !== "http") {
      bases.push(`http://${hostHeader}`);
    }
  }

  if (bases.length === 0) {
    bases.push("https://agent.mailcallcommunication.com");
  }

  const uniqueBases = [...new Set(bases)];
  const urls: string[] = [];
  for (const base of uniqueBases) {
    urls.push(`${base}${path}`);
    if (!path.endsWith("/")) {
      urls.push(`${base}${path}/`);
    } else if (path.length > 1) {
      urls.push(`${base}${path.replace(/\/$/, "")}`);
    }
  }
  return [...new Set(urls)];
}
