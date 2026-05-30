import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * When VOICE_COMMERCE_API_KEY is set, require matching x-voice-api-key header.
 * When unset (dev), allow public ElevenLabs tool webhooks.
 */
@Injectable()
export class VoiceApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('VOICE_COMMERCE_API_KEY')?.trim();
    if (!expected) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const provided =
      (typeof req.headers['x-voice-api-key'] === 'string' && req.headers['x-voice-api-key']) ||
      (typeof req.headers.authorization === 'string' &&
        req.headers.authorization.replace(/^Bearer\s+/i, '')) ||
      '';

    if (provided.trim() !== expected) {
      throw new UnauthorizedException('Invalid voice commerce API key.');
    }
    return true;
  }
}
