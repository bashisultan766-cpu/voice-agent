import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  MaxLength,
  IsUrl,
  IsEmail,
  MinLength,
  IsArray,
  IsIn,
} from 'class-validator';
import { Transform } from 'class-transformer';

function trimToUndefined(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUrl(value: unknown): unknown {
  const v = trimToUndefined(value);
  if (typeof v !== 'string') return v;
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

/** Accept JSON string or string[] from dashboard / voice tools; normalize for validation. */
function escalationRulesToArray(value: unknown): string[] | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (Array.isArray(value)) {
    const lines = value.map((v) => String(v).trim()).filter(Boolean);
    return lines.length > 0 ? lines : undefined;
  }
  if (typeof value === 'string') {
    const lines = value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.length > 0 ? lines : undefined;
  }
  return undefined;
}

export enum AgentStatusDto {
  DRAFT = 'draft',
  ACTIVE = 'active',
  PAUSED = 'paused',
}

export class CreateAgentDto {
  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsString()
  storeId?: string;

  @IsString()
  @MinLength(1, { message: 'Agent name is required.' })
  @MaxLength(200)
  agentName: string;

  @IsString()
  @MinLength(1, { message: 'Store name is required.' })
  @MaxLength(200)
  storeName: string;

  @IsOptional()
  @Transform(({ value }) => normalizeUrl(value))
  @IsString()
  @MaxLength(500)
  @IsUrl({}, { message: 'Store URL must be a valid URL.' })
  storeUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @IsEmail({}, { message: 'Store email must be a valid email.' })
  storeEmail?: string;

  @IsOptional()
  @IsEnum(AgentStatusDto)
  agentStatus?: AgentStatusDto;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  voiceProvider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  voiceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  voiceStyle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  elevenlabsModel?: string;

  @IsOptional()
  @IsIn(['auto', 'fixed'])
  languageMode?: 'auto' | 'fixed';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  fixedLanguage?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  supportedLanguages?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  greetingMessage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  fallbackMessage?: string;

  @IsOptional()
  @Transform(({ value }) => normalizeUrl(value))
  @IsString()
  @MaxLength(500)
  @IsUrl({}, { message: 'Shopify store URL must be a valid URL.' })
  shopifyStoreUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  shopifyStoreNumber?: string;

  @IsOptional()
  @IsString()
  shopifyAdminToken?: string;

  @IsOptional()
  @IsString()
  shopifyApiKey?: string;

  @IsOptional()
  @IsString()
  shopifyApiSecret?: string;

  @IsOptional()
  @IsString()
  webhookSecret?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  databaseProvider?: string;

  @IsOptional()
  @IsString()
  databaseUrl?: string;

  @IsOptional()
  @IsString()
  databaseAccessToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  knowledgeBaseSource?: string;

  @IsOptional()
  @IsBoolean()
  knowledgeSyncEnabled?: boolean;

  @IsOptional()
  @IsString()
  twilioAccountSid?: string;

  @IsOptional()
  @IsString()
  twilioAuthToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  twilioPhoneNumber?: string;

  // --- AI provider credentials (stored encrypted) ---
  @IsOptional()
  @IsString()
  openaiApiKey?: string;

  @IsOptional()
  @IsString()
  elevenlabsApiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  callRoutingMode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  incomingCallHandling?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  openAiModel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  systemPrompt?: string;

  /** Alias for `allowedActions` (dashboard topic allow-list). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  allowedTopics?: string;

  /** Alias for `restrictedActions` (dashboard topic block-list). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  blockedTopics?: string;

  /** Alias for `agentGoal` (product guidance). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  productGuidance?: string;

  /** Alias for `humanHandoffRules` (checkout instructions). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  checkoutInstructions?: string;

  /** Alias for `returnPolicy`. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  refundPolicy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  agentGoal?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  agentRole?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  toneOfVoice?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  allowedActions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  restrictedActions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  escalationInstructions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  returnRefundBehavior?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  orderStatusHandling?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  outOfStockHandling?: string;

  @IsOptional()
  @IsBoolean()
  transferToHumanEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  escalationPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @IsEmail({}, { message: 'Escalation email must be a valid email.' })
  escalationEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  businessName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @IsEmail({}, { message: 'Support email must be a valid email.' })
  supportEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  supportPhone?: string;

  @IsOptional()
  @IsBoolean()
  askEmailBeforePaymentLink?: boolean;

  @IsOptional()
  @IsString()
  checkoutMode?: 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE' | 'cart' | 'draft_order';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  humanHandoffRules?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  shippingPolicy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  returnPolicy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  exchangePolicy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  deliveryNotes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  forbiddenBehaviors?: string;

  @IsOptional()
  @Transform(({ value }) => escalationRulesToArray(value))
  @IsArray()
  @IsString({ each: true })
  escalationRules?: string[];

  /** When true, empty credential fields are filled from encrypted workspace integration settings before validation. */
  @IsOptional()
  @IsBoolean()
  useWorkspaceDefaults?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  voiceNameLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  emailSenderName?: string;

  @IsOptional()
  @Transform(({ value }) => trimToUndefined(value))
  @IsString()
  @MaxLength(255)
  @IsEmail({}, { message: 'Sender email must be a valid email.' })
  emailSenderAddress?: string;

  @IsOptional()
  @Transform(({ value }) => trimToUndefined(value))
  @IsString()
  @MaxLength(255)
  @IsEmail({}, { message: 'Reply-to email must be a valid email.' })
  emailReplyTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  emailSubjectTemplate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  paymentLinkEmailIntro?: string;

  @IsOptional()
  @Transform(({ value }) => trimToUndefined(value))
  @IsString()
  @MaxLength(255)
  @IsEmail({}, { message: 'Test email recipient must be a valid email.' })
  emailTestRecipient?: string;

  @IsOptional()
  @IsBoolean()
  useWorkspaceEmail?: boolean;

  @IsOptional()
  @IsBoolean()
  useWorkspaceOpenai?: boolean;

  @IsOptional()
  @IsBoolean()
  useWorkspaceElevenlabs?: boolean;

  @IsOptional()
  @IsBoolean()
  useWorkspaceTwilio?: boolean;

  /** When true, runtime uses workspace Shopify integration instead of per-agent store credentials. */
  @IsOptional()
  @IsBoolean()
  useWorkspaceShopify?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  shopifyApiVersion?: string;

  @IsOptional()
  @IsString()
  resendApiKey?: string;

  /** Dashboard tool permission toggles; synced to enabledTools at save. */
  @IsOptional()
  toolPermissions?: Record<string, boolean>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledTools?: string[];

  /** Voice personality sliders (0–100). Stored on VoiceProfile.providerConfig.personality */
  @IsOptional()
  voicePersonality?: Record<string, number>;
}
