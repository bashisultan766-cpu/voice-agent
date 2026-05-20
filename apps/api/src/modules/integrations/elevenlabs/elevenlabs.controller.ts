import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { ElevenLabsService } from './elevenlabs.service';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { elevenLabsTestBodySchema } from './elevenlabs-validation';
import type { z } from 'zod';

@Controller('integrations/elevenlabs')
@Roles(UserRole.MANAGER)
export class ElevenLabsController {
  constructor(private readonly elevenLabs: ElevenLabsService) {}

  /** Verify API key and voice id; does not stream audio to the client. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('test')
  async test(
    @TenantId() _tenantId: string,
    @Body(new ZodValidationPipe(elevenLabsTestBodySchema)) body: z.infer<typeof elevenLabsTestBodySchema>,
  ) {
    await this.elevenLabs.textToSpeech(
      body.text ?? 'Hello, this is a voice agent test.',
      body.voiceId,
    );
    return { ok: true, message: 'ElevenLabs returned audio successfully.' };
  }
}
