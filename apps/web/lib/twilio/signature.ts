import twilio from 'twilio';
import type { IncomingMessage } from 'http';

function shouldValidate(): boolean {
  const v = process.env.VALIDATE_TWILIO_SIGNATURES;
  if (v === 'false' || v === '0') return false;
  return true;
}

export function validateTwilioPostRequest(params: {
  signature: string | null | undefined;
  url: string;
  body: Record<string, string>;
}): boolean {
  if (!shouldValidate()) return true;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  if (!params.signature) return false;
  return twilio.validateRequest(token, params.signature, params.url, params.body);
}

/**
 * ConversationRelay sends `X-Twilio-Signature` on the WebSocket upgrade request.
 * Use the public URL Twilio called (wss), matching Twilio's webhook security docs.
 */
export function validateTwilioWebSocketRequest(params: {
  signature: string | null | undefined;
  publicWsUrl: string;
}): boolean {
  if (!shouldValidate()) return true;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  if (!params.signature) return false;

  // Twilio signs the canonical URL of your WebSocket endpoint; some proxies use https vs wss.
  if (twilio.validateRequest(token, params.signature, params.publicWsUrl, {})) return true;
  const httpish = params.publicWsUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  return twilio.validateRequest(token, params.signature, httpish, {});
}

export function getPublicUrlFromRequest(req: IncomingMessage, pathname: string): string {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  const protoHeader = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const isHttps = protoHeader === 'https' || protoHeader === 'wss';
  const httpProto = isHttps ? 'https' : 'http';
  return `${httpProto}://${host}${pathname}`;
}

export function getPublicWebSocketUrlFromRequest(req: IncomingMessage, pathname: string): string {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  const protoHeader = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const isTls = protoHeader === 'https' || protoHeader === 'wss';
  const wsProto = isTls ? 'wss' : 'ws';
  return `${wsProto}://${host}${pathname}`;
}
