import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  buildSignedUrlCandidates,
  validateTwilioSignature,
} from "../src/utils/twilioSignature.js";

function sign(authToken: string, url: string, params: Record<string, string>): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

describe("validateTwilioSignature", () => {
  const authToken = "test_auth_token_123";
  const params = {
    CallSid: "CAxxxxxxxx",
    From: "+15551234567",
    To: "+12014290422",
  };
  const url = "https://agent.mailcallcommunication.com/api/voice/mailcall/inbound";
  const rawBody = new URLSearchParams(params).toString();

  it("accepts a valid signature using rawBody + public HTTPS base", () => {
    const signature = sign(authToken, url, params);
    const req = {
      header: (name: string) => (name === "X-Twilio-Signature" ? signature : undefined),
      get: () => "127.0.0.1:8010",
      protocol: "http",
      originalUrl: "/api/voice/mailcall/inbound",
      url: "/api/voice/mailcall/inbound",
      body: params,
      rawBody: Buffer.from(rawBody, "utf8"),
    } as unknown as Request;

    expect(() =>
      validateTwilioSignature(
        req,
        authToken,
        true,
        "https://agent.mailcallcommunication.com",
      ),
    ).not.toThrow();
  });

  it("accepts when Twilio signed https but Express sees http via proxy", () => {
    const signature = sign(authToken, url, params);
    const req = {
      header: (name: string) => {
        if (name === "X-Twilio-Signature") return signature;
        if (name === "x-forwarded-proto") return "http";
        if (name === "x-forwarded-host") return "agent.mailcallcommunication.com";
        return undefined;
      },
      get: () => "agent.mailcallcommunication.com",
      protocol: "http",
      originalUrl: "/api/voice/mailcall/inbound",
      url: "/api/voice/mailcall/inbound",
      body: params,
      rawBody: Buffer.from(rawBody, "utf8"),
    } as unknown as Request;

    expect(() => validateTwilioSignature(req, authToken, true)).not.toThrow();
  });

  it("rejects an invalid signature", () => {
    const req = {
      header: () => "not-a-real-signature===========",
      get: () => "agent.mailcallcommunication.com",
      protocol: "https",
      originalUrl: "/api/voice/mailcall/inbound",
      body: params,
      rawBody: Buffer.from(rawBody, "utf8"),
    } as unknown as Request;

    expect(() =>
      validateTwilioSignature(
        req,
        authToken,
        true,
        "https://agent.mailcallcommunication.com",
      ),
    ).toThrow(/Invalid Twilio signature/);
  });

  it("buildSignedUrlCandidates includes https upgrade", () => {
    const req = {
      header: (name: string) => {
        if (name === "x-forwarded-proto") return "http";
        if (name === "x-forwarded-host") return "agent.mailcallcommunication.com";
        return undefined;
      },
      get: () => "agent.mailcallcommunication.com",
      protocol: "http",
      originalUrl: "/api/voice/mailcall/inbound",
    } as unknown as Request;

    const urls = buildSignedUrlCandidates(req);
    expect(urls.some((u) => u.startsWith("https://"))).toBe(true);
    expect(urls).toContain(
      "https://agent.mailcallcommunication.com/api/voice/mailcall/inbound",
    );
  });
});
