import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import type { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { TenantIntegrationsService } from './tenant-integrations.service';
import {
  emailSaveBodySchema,
  emailTestBodySchema,
  twilioConfigureWebhookBodySchema,
  twilioSaveBodySchema,
  twilioTestBodySchema,
} from './tenant-integrations-validation';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

/** Whitelist-safe DTOs so ValidationPipe does not strip body fields. */
class ShopifyTestBodyDto {
  @IsString()
  shopDomain!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value))
  @IsString()
  accessToken?: string;
}

class ShopifySaveBodyDto {
  @IsString()
  shopDomain!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value))
  @IsString()
  accessToken?: string;

  @IsOptional()
  @IsBoolean()
  skipConnectionTest?: boolean;
}

class OpenaiTestBodyDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value))
  @IsString()
  apiKey?: string;
}

class OpenaiSaveBodyDto {
  /** Omit when re-validating the existing encrypted key only. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value))
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsBoolean()
  skipConnectionTest?: boolean;
}

class ElevenlabsTestBodyDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value))
  @IsString()
  apiKey?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value))
  @IsString()
  voiceId?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value))
  @IsString()
  model?: string;
}

class ElevenlabsSaveBodyDto extends ElevenlabsTestBodyDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value))
  @IsString()
  defaultVoiceId?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value))
  @IsString()
  defaultModel?: string;

  @IsOptional()
  @IsBoolean()
  skipConnectionTest?: boolean;
}

@Controller('tenant-integrations')
@Roles(UserRole.MANAGER)
export class TenantIntegrationsController {
  constructor(private readonly svc: TenantIntegrationsService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  summary(@TenantId() tenantId: string) {
    return this.svc.getSafeSummary(tenantId);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('shopify/test')
  testShopify(@TenantId() tenantId: string, @Body() body: ShopifyTestBodyDto) {
    return this.svc.testShopify(tenantId, body);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put('shopify')
  saveShopify(@TenantId() tenantId: string, @Body() body: ShopifySaveBodyDto) {
    return this.svc.saveShopify(tenantId, body);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('twilio/test')
  testTwilio(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(twilioTestBodySchema)) body: z.infer<typeof twilioTestBodySchema>,
  ) {
    return this.svc.testTwilio(tenantId, body);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put('twilio')
  saveTwilio(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(twilioSaveBodySchema)) body: z.infer<typeof twilioSaveBodySchema>,
  ) {
    return this.svc.saveTwilio(tenantId, body);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('twilio/configure-webhook')
  configureTwilioWebhook(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(twilioConfigureWebhookBodySchema))
    _body: z.infer<typeof twilioConfigureWebhookBodySchema>,
  ) {
    return this.svc.configureTwilioWebhook(tenantId);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('openai/test')
  testOpenai(@TenantId() tenantId: string, @Body() body: OpenaiTestBodyDto) {
    return this.svc.testOpenai(tenantId, body);
  }

  /** Test the encrypted workspace key on file (no key in body — never echoes secrets). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('openai/test-saved')
  testOpenaiSaved(@TenantId() tenantId: string) {
    return this.svc.testOpenai(tenantId, {});
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put('openai')
  saveOpenai(@TenantId() tenantId: string, @Body() body: OpenaiSaveBodyDto) {
    return this.svc.saveOpenai(tenantId, body);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('elevenlabs/test')
  testElevenlabs(@TenantId() tenantId: string, @Body() body: ElevenlabsTestBodyDto) {
    return this.svc.testElevenlabs(tenantId, body);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put('elevenlabs')
  saveElevenlabs(@TenantId() tenantId: string, @Body() body: ElevenlabsSaveBodyDto) {
    return this.svc.saveElevenlabs(tenantId, body);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('email/test')
  testEmail(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(emailTestBodySchema)) body: z.infer<typeof emailTestBodySchema>,
  ) {
    return this.svc.testEmail(tenantId, body);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put('email')
  saveEmail(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(emailSaveBodySchema)) body: z.infer<typeof emailSaveBodySchema>,
  ) {
    return this.svc.saveEmail(tenantId, body);
  }
}
