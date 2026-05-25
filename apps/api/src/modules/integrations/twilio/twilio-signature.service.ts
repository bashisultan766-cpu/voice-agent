import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import type { Request } from 'express';
import { normalizePublicWebhookBaseUrl } from '../../../common/public-webhook-base-url';
import { TwilioAuthTokenResolverService } from './twilio-auth-token-resolver.service';

/**
 * Validates Twilio request signature (HMAC-SHA1 of URL + sorted POST params, Base64).
 * Uses per-agent Twilio credentials when the called number maps to an agent.
 */
@Injectable()
export class TwilioSignatureService {
  constructor(
    private readonly config: ConfigService,
    private readonly authTokenResolver: TwilioAuthTokenResolverService,
  ) {}

  private isTrustedProxyUrlHeader(req: Request): boolean {
    const expected = this.config.get<string>('TWILIO_PROXY_SHARED_SECRET')?.trim();
    if (!expected) return false;
    const provided = (req.headers['x-twilio-proxy-secret'] as string | undefined)?.trim();
    if (!provided) return false;
    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);
    if (providedBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  }

  isValidationEnabled(): boolean {
    return this.config.get<string>('VALIDATE_TWILIO_SIGNATURES') !== 'false';
  }

  validateWithToken(url: string, params: Record<string, string>, signature: string, authToken: string): boolean {
    if (!authToken || !signature) return false;
    const payload = url + this.sortedParams(params);
    const expected = crypto.createHmac('sha1', authToken).update(payload).digest('base64');
    try {
      const sigBuf = Buffer.from(signature, 'base64');
      const expBuf = Buffer.from(expected, 'base64');
      if (sigBuf.length !== expBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  }

  /** @deprecated Use validateInbound; kept for callers passing a single token. */
  validate(url: string, params: Record<string, string>, signature: string): boolean {
    const authToken = this.config.get<string>('TWILIO_AUTH_TOKEN');
    if (!authToken) return false;
    return this.validateWithToken(url, params, signature, authToken);
  }

  /** Validate signature using agent/workspace token for To, then optional global fallback. */
  async validateInbound(
    url: string,
    params: Record<string, string>,
    signature: string,
  ): Promise<boolean> {
    const to = params.To ?? params.to;
    const candidates = await this.authTokenResolver.resolveValidationTokens(to);
    for (const { token } of candidates) {
      if (this.validateWithToken(url, params, signature, token)) return true;
    }
    return false;
  }

  resolveValidationUrl(req: Request): string {
    const originalUrlHeader = (req.headers['x-original-url'] as string | undefined)?.trim();
    if (originalUrlHeader && this.isTrustedProxyUrlHeader(req)) {
      try {
        return new URL(originalUrlHeader).toString();
      } catch {
        // Ignore malformed header and continue with computed fallback.
      }
    }

    const fromProxyProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
    const fromProxyHost = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
    const proto = fromProxyProto || req.protocol || 'https';
    const host = fromProxyHost || req.get('host');
    const originalUrl = req.originalUrl || req.url || '';
    if (host && originalUrl) {
      return `${proto}://${host}${originalUrl}`;
    }
    const baseUrl = normalizePublicWebhookBaseUrl(
      this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL'),
    );
    return `${baseUrl}${originalUrl}`;
  }

  private sortedParams(params: Record<string, string>): string {
    return Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  }
}
