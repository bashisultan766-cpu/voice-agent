import { Transform } from 'class-transformer';
import { IsBoolean, IsString, IsOptional, MaxLength, Matches, MinLength } from 'class-validator';

function trimToOptionalString(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? undefined : t;
}

function toOptionalBoolean(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return value;
}

/** Optional credentials sent when testing (e.g. from create flow or to override). Only these two fields are used; extra keys are ignored. */
export class TestShopifyCredentialsDto {
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsOptional()
  @IsBoolean()
  useWorkspaceDefaults?: boolean;

  @Transform(({ value }) => trimToOptionalString(value))
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^(https?:\/\/)?[a-z0-9-]+\.myshopify\.com(\/.*)?$/i, {
    message: 'Shopify store URL must be a myshopify domain (e.g. your-store.myshopify.com).',
  })
  shopifyStoreUrl?: string;

  @Transform(({ value }) => trimToOptionalString(value))
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(2000)
  shopifyAdminToken?: string;
}

export class TestDatabaseCredentialsDto {
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsOptional()
  @IsBoolean()
  useWorkspaceDefaults?: boolean;

  @IsOptional()
  @IsString()
  databaseUrl?: string;

  @IsOptional()
  @IsString()
  databaseAccessToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  databaseProvider?: string;
}

export class TestTwilioCredentialsDto {
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsOptional()
  @IsBoolean()
  useWorkspaceDefaults?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^AC[a-fA-F0-9]{32}$/, { message: 'Twilio Account SID format is invalid.' })
  twilioAccountSid?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  twilioAuthToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  twilioPhoneNumber?: string;
}

export class TestOpenAICredentialsDto {
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsOptional()
  @IsBoolean()
  useWorkspaceDefaults?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(20)
  openaiApiKey?: string;
}

export class TestElevenLabsCredentialsDto {
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsOptional()
  @IsBoolean()
  useWorkspaceDefaults?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(10)
  elevenlabsApiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  voiceId?: string;
}
