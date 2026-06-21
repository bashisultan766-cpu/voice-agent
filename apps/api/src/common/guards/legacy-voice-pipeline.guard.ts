import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { DEPRECATED_VOICE_PIPELINE_MESSAGE } from '../deprecated-voice-pipeline.util';

/**
 * Blocks legacy NestJS Twilio voice webhooks (gather, inbound, media-stream TwiML).
 * Production voice calls must hit services/voice-agent POST /voice/incoming.
 */
@Injectable()
export class LegacyVoicePipelineGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    throw new HttpException(DEPRECATED_VOICE_PIPELINE_MESSAGE, HttpStatus.GONE);
  }
}
