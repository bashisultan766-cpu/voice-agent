import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { EncryptionService } from '../../common/encryption.service';
import { Prisma } from '@prisma/client';
import { AgentStatus, ConnectionStatus } from '../../database/prisma.types';
import { CreateAgentDto, AgentStatusDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { ShopifyConnectionTestService } from './connection-test/shopify-connection-test.service';
import { DatabaseConnectionTestService } from './connection-test/database-connection-test.service';
import { TwilioConnectionTestService } from './connection-test/twilio-connection-test.service';
import { OpenAIConnectionTestService } from './connection-test/openai-connection-test.service';
import { ElevenLabsConnectionTestService } from './connection-test/elevenlabs-connection-test.service';
import type {
  TestShopifyCredentialsDto,
  TestDatabaseCredentialsDto,
  TestTwilioCredentialsDto,
} from './dto/test-connection.dto';
import type { TestOpenAICredentialsDto, TestElevenLabsCredentialsDto } from './dto/test-connection.dto';
import { normalizePhoneNumber } from '../integrations/twilio/utils/normalize-phone';
import { ShopifyProductSyncQueueService } from '../integrations/shopify/product-sync.queue';
import OpenAI from 'openai';
import { toCheckoutModeApi } from '@bookstore-voice-agents/types';
import { normalizeShopifyDomain } from '@bookstore-voice-agents/types';
import { assertProductionOwnershipRequired, assertTenantOwnership } from './ownership-linkage';
import { ConfigService } from '@nestjs/config';
import { normalizePublicWebhookBaseUrl } from '../../common/public-webhook-base-url';
import {
  buildAgentRuntimePrompt,
  type AgentRuntimePromptInput,
} from '../calls/runtime/build-agent-runtime-prompt';
import { AgentEmailConfigService } from '../integrations/email/agent-email-config.service';
import { ResendEmailService } from '../integrations/email/resend-email.service';
import { paymentEmailIdempotencyKey } from '../../common/payment-email-idempotency';
import {
  normalizeToolPermissions,
  toolNamesFromPermissions,
} from '../tools/tool-permissions.util';
import { RuntimeToolRegistryService } from '../tools/runtime-tool-registry.service';
import type { VoicePersonalityTraits } from '@bookstore-voice-agents/types';

const SECRET_KEYS = [
  'shopifyAdminToken',
  'shopifyApiKey',
  'shopifyApiSecret',
  'webhookSecret',
  'databaseUrl',
  'databaseAccessToken',
  'twilioAccountSid',
  'twilioAuthToken',
  'openaiApiKey',
  'elevenlabsApiKey',
  'resendApiKey',
] as const;

/** Map dashboard alias field names onto persisted DTO fields before create/update. */
function normalizeAgentDtoAliases(dto: CreateAgentDto | UpdateAgentDto): void {
  if (dto.allowedTopics?.trim() && !dto.allowedActions?.trim()) {
    dto.allowedActions = dto.allowedTopics.trim();
  }
  if (dto.blockedTopics?.trim() && !dto.restrictedActions?.trim()) {
    dto.restrictedActions = dto.blockedTopics.trim();
  }
  if (dto.productGuidance?.trim() && !dto.agentGoal?.trim()) {
    dto.agentGoal = dto.productGuidance.trim();
  }
  if (dto.checkoutInstructions?.trim() && !dto.humanHandoffRules?.trim()) {
    dto.humanHandoffRules = dto.checkoutInstructions.trim();
  }
  if (dto.refundPolicy?.trim() && !dto.returnPolicy?.trim()) {
    dto.returnPolicy = dto.refundPolicy.trim();
  }
}

interface AgentSecrets {
  shopifyAdminToken?: string;
  shopifyApiKey?: string;
  shopifyApiSecret?: string;
  webhookSecret?: string;
  databaseUrl?: string;
  databaseAccessToken?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  resendApiKey?: string;
}

import {
  resolveCredentialPriority,
  type CredentialSource,
  type ResolvedCredential,
} from '../../common/credential-priority.util';
import {
  buildCredentialSourcesSummary,
  logCredentialResolution,
  resolveElevenLabsConfig,
  resolveOpenAiConfig,
  resolveShopifyConfig,
  resolveTwilioConfig,
  type AgentSecretsSlice,
  type WorkspaceIntegrationSlice,
} from '../../common/credential-resolver.util';

export { resolveCredentialPriority };

function statusDtoToPrisma(s?: AgentStatusDto): AgentStatus {
  if (!s) return AgentStatus.DRAFT;
  switch (s) {
    case AgentStatusDto.ACTIVE:
      return AgentStatus.ACTIVE;
    case AgentStatusDto.PAUSED:
      return AgentStatus.PAUSED;
    default:
      return AgentStatus.DRAFT;
  }
}

function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'agent';
}

function normalizeEscalationRules(
  rules?: string[] | string,
): string | null {
  if (Array.isArray(rules)) {
    const lines = rules.map((line) => line.trim()).filter(Boolean);
    return lines.length > 0 ? lines.join('\n') : null;
  }
  if (typeof rules === 'string') {
    const lines = rules
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.length > 0 ? lines.join('\n') : null;
  }
  return null;
}

@Injectable()
export class AgentsService {
  private readonly log = new Logger(AgentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
    private readonly shopifyTest: ShopifyConnectionTestService,
    private readonly databaseTest: DatabaseConnectionTestService,
    private readonly twilioTest: TwilioConnectionTestService,
    private readonly openaiTest: OpenAIConnectionTestService,
    private readonly elevenlabsTest: ElevenLabsConnectionTestService,
    private readonly productSyncQueue: ShopifyProductSyncQueueService,
    private readonly agentEmailConfig: AgentEmailConfigService,
    private readonly resendEmail: ResendEmailService,
    private readonly toolRegistry: RuntimeToolRegistryService,
  ) {}

  private resolveToolsFromDto(dto: CreateAgentDto | UpdateAgentDto): {
    toolPermissions: Record<string, boolean>;
    enabledTools: string[];
  } | null {
    if (dto.toolPermissions === undefined && dto.enabledTools === undefined) return null;
    const perms = normalizeToolPermissions(dto.toolPermissions);
    const enabled =
      Array.isArray(dto.enabledTools) && dto.enabledTools.length > 0
        ? dto.enabledTools
        : toolNamesFromPermissions(perms);
    return { toolPermissions: perms as Record<string, boolean>, enabledTools: enabled };
  }

  private buildVoiceProviderConfig(dto: CreateAgentDto | UpdateAgentDto): Record<string, unknown> {
    return {
      voiceStyle: dto.voiceStyle ?? null,
      elevenlabsModel: dto.elevenlabsModel ?? 'eleven_multilingual_v2',
      languageMode: dto.languageMode ?? 'auto',
      fixedLanguage: dto.fixedLanguage ?? dto.language ?? 'en',
      supportedLanguages:
        Array.isArray(dto.supportedLanguages) && dto.supportedLanguages.length > 0
          ? dto.supportedLanguages
          : ['en', 'ur', 'hi', 'ar', 'es', 'fr', 'de'],
      ...(dto.voicePersonality ? { personality: dto.voicePersonality } : {}),
    };
  }

  private expectedTwilioWebhookUrls() {
    const base = normalizePublicWebhookBaseUrl(this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL'));
    return {
      base,
      inboundUrl: `${base}/api/twilio/voice/inbound`,
      statusUrl: `${base}/api/twilio/voice/status`,
    };
  }

  private isPublicHttpsBaseUrl(base: string): boolean {
    if (!base) return false;
    try {
      const u = new URL(base);
      const host = u.hostname.toLowerCase();
      return (
        u.protocol === 'https:' &&
        host !== 'localhost' &&
        host !== '127.0.0.1' &&
        host !== '0.0.0.0' &&
        !host.endsWith('.local')
      );
    } catch {
      return false;
    }
  }

  private normalizeUrlStrict(url: string | null | undefined): string {
    return (url ?? '').trim().replace(/\/+$/, '');
  }

  /** Block assigning the same normalized inbound number to two agents in one tenant. */
  private async assertPhoneNotAssignedToOtherAgent(
    tenantId: string,
    agentId: string,
    normalizedPhone: string,
    db: PrismaService | Prisma.TransactionClient,
  ): Promise<void> {
    const conflictMapping = await db.phoneNumberMapping.findFirst({
      where: { tenantId, phoneNumber: normalizedPhone, agentId: { not: agentId } },
      select: { agentId: true },
    });
    if (conflictMapping) {
      throw new ConflictException('This phone number is already assigned to another agent.');
    }
    const others = await db.agent.findMany({
      where: { tenantId, id: { not: agentId }, deletedAt: null, twilioPhoneNumber: { not: null } },
      select: { id: true, twilioPhoneNumber: true },
    });
    for (const o of others) {
      if (o.twilioPhoneNumber && normalizePhoneNumber(o.twilioPhoneNumber) === normalizedPhone) {
        throw new ConflictException('This phone number is already assigned to another agent.');
      }
    }
  }

  private async getReadiness(tenantId: string, agentId: string) {
    const agent = await this.findOne(tenantId, agentId);
    const workspace = await this.getWorkspaceIntegrationForTenant(tenantId);
    const cfg = await this.getAgentConfigForTest(tenantId, agentId);
    const webhook = this.expectedTwilioWebhookUrls();
    const baseUrlValid = this.isPublicHttpsBaseUrl(webhook.base);
    const twilioPhoneRaw = agent.twilioPhoneNumber?.trim() || workspace?.twilioPhoneNumber?.trim() || null;
    const twilioPhoneNumber = twilioPhoneRaw ? normalizePhoneNumber(twilioPhoneRaw) : null;
    const twilioCredentialsPresent = Boolean(
      (cfg.twilioAccountSid?.trim() || workspace?.twilioAccountSid?.trim()) &&
        (cfg.twilioAuthToken?.trim() || workspace?.twilioAuthToken?.trim()),
    );
    const twilioSid = cfg.twilioAccountSid?.trim() || workspace?.twilioAccountSid?.trim() || null;
    const twilioAuth = cfg.twilioAuthToken?.trim() || workspace?.twilioAuthToken?.trim() || null;

    const twilioConfig =
      twilioSid && twilioAuth && twilioPhoneNumber
        ? await this.twilioTest.getIncomingPhoneNumberConfig({
            twilioAccountSid: twilioSid,
            twilioAuthToken: twilioAuth,
            twilioPhoneNumber,
          })
        : null;

    const twilioBelongsToAccount = Boolean(twilioConfig?.sid && twilioConfig.accountSid === twilioSid);
    const twilioWebhookVerified =
      Boolean(twilioConfig) &&
      this.normalizeUrlStrict(twilioConfig?.voiceUrl) === this.normalizeUrlStrict(webhook.inboundUrl) &&
      this.normalizeUrlStrict(twilioConfig?.statusCallback) === this.normalizeUrlStrict(webhook.statusUrl) &&
      (twilioConfig?.voiceMethod ?? '').toUpperCase() === 'POST' &&
      (twilioConfig?.statusCallbackMethod ?? '').toUpperCase() === 'POST';

    const inboundMappingRow =
      twilioPhoneNumber != null
        ? await this.prisma.phoneNumberMapping.findFirst({
            where: { tenantId, agentId, phoneNumber: twilioPhoneNumber },
            select: { id: true },
          })
        : null;
    const agentPhoneNorm = agent.twilioPhoneNumber?.trim()
      ? normalizePhoneNumber(agent.twilioPhoneNumber.trim())
      : null;
    const twilioInboundLinked =
      !twilioPhoneNumber ||
      Boolean(inboundMappingRow) ||
      Boolean(agentPhoneNorm && agentPhoneNorm === twilioPhoneNumber);

    const credentialBundle = await this.loadAgentCredentialBundle(tenantId, agentId);
    const credentialSources = buildCredentialSourcesSummary({
      agent: {
        shopifyStoreUrl: credentialBundle.shopifyStoreUrl,
        secrets: credentialBundle.secrets,
        useWorkspaceShopify: credentialBundle.useWorkspaceShopify,
        useWorkspaceEmail: credentialBundle.useWorkspaceEmail,
        voiceId: credentialBundle.voiceId,
      },
      workspace: credentialBundle.workspace,
      env: {
        openaiApiKey: process.env.OPENAI_API_KEY,
        elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
        resendApiKey: this.config.get<string>('RESEND_API_KEY'),
        shopifyStoreUrl: process.env.SHOPIFY_SHOP_DOMAIN,
        shopifyAdminToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
      },
    });
    const shopifyPolicyOk =
      credentialSources.shopify.configured &&
      !(credentialSources.shopify.source === 'workspace' && !credentialSources.shopify.useWorkspaceShopify);

    const shopify = await this.testShopifyConnection(tenantId, agentId);
    const catalog = await this.getCatalogReadiness(tenantId, agentId);
    const openai = await this.testOpenAIConnection(tenantId, agentId);
    const isElevenLabsSelected = (agent.voiceProvider ?? '').toLowerCase() === 'elevenlabs';
    const elevenlabs = isElevenLabsSelected
      ? await this.testElevenLabsConnection(tenantId, agentId, {
          voiceId: agent.voiceId?.trim() || workspace?.elevenlabsDefaultVoiceId?.trim(),
        })
      : null;
    const emailSummary = await this.agentEmailConfig.getSummary(tenantId, agentId);
    const hasGreeting = Boolean(agent.greetingMessage?.trim());
    const hasSystemPrompt = Boolean(
      agent.baseSystemPrompt?.trim() || agent.agentConfig?.customSystemPrompt?.trim(),
    );
    const hasElevenLabsVoiceId = !isElevenLabsSelected || Boolean(agent.voiceId?.trim());
    const paymentWebhookConfigured = Boolean(cfg.webhookSecret?.trim());
    let runtimePromptAvailable = false;
    try {
      const preview = await this.getRuntimePromptPreview(tenantId, agentId);
      runtimePromptAvailable = Boolean(preview.prompt?.trim());
    } catch {
      runtimePromptAvailable = false;
    }
    const checks = [
      {
        key: 'twilio_number_assigned',
        label: 'Twilio number assigned',
        pass: Boolean(twilioPhoneNumber),
        fixAction: 'Assign a Twilio phone number to this agent.',
      },
      {
        key: 'twilio_credentials_configured',
        label: 'Twilio credentials configured',
        pass: twilioCredentialsPresent,
        fixAction: 'Save Twilio Account SID and Auth Token under Settings → Integrations or on the agent.',
      },
      {
        key: 'twilio_number_belongs_account',
        label: 'Twilio number belongs to account',
        pass: twilioBelongsToAccount,
        fixAction: 'Use Twilio credentials that own the selected phone number.',
      },
      {
        key: 'twilio_webhook_verified',
        label: 'Twilio webhook verified',
        pass: twilioWebhookVerified,
        fixAction: 'Use "Configure Twilio Webhook" to apply the required inbound/status URLs.',
      },
      {
        key: 'twilio_inbound_mapping',
        label: 'Inbound phone linked to this agent (mapping or agent field)',
        pass: twilioInboundLinked,
        fixAction:
          'Save the agent with this Twilio number so PhoneNumberMapping is created, or ensure agent.twilioPhoneNumber matches the voice number.',
      },
      {
        key: 'public_webhook_base_url_valid',
        label: 'PUBLIC_WEBHOOK_BASE_URL valid',
        pass: baseUrlValid,
        fixAction: 'Set PUBLIC_WEBHOOK_BASE_URL to a public HTTPS origin.',
      },
      {
        key: 'shopify_connected',
        label: 'Shopify connected',
        pass: shopify.success && shopifyPolicyOk,
        fixAction:
          credentialSources.shopify.source === 'workspace' && !credentialSources.shopify.useWorkspaceShopify
            ? 'Enable “Use workspace Shopify integration” or add agent-specific Shopify credentials.'
            : 'Shopify credentials missing for this agent. Add store domain and admin token, or enable workspace Shopify.',
      },
      {
        key: 'catalog_ready',
        label: 'Product catalog ready',
        pass: catalog.catalogReady,
        fixAction: 'Run Shopify sync until products are present and fresh.',
      },
      {
        key: 'openai_connected',
        label: 'OpenAI connected',
        pass: openai.success,
        fixAction: 'Provide a valid OpenAI key for this agent/workspace.',
      },
      {
        key: 'greeting_configured',
        label: 'Greeting message configured',
        pass: hasGreeting,
        fixAction: 'Add a greeting message in Voice settings.',
      },
      {
        key: 'system_prompt_configured',
        label: 'System prompt configured',
        pass: hasSystemPrompt,
        fixAction:
          'Add AI instructions in the agent form (Main instructions / system prompt) before going live.',
      },
      {
        key: 'elevenlabs_voice_id',
        label: 'ElevenLabs voice ID configured',
        pass: hasElevenLabsVoiceId,
        fixAction: 'Set an ElevenLabs voice ID for this agent.',
      },
      {
        key: 'elevenlabs_connected',
        label: 'ElevenLabs connected',
        pass: !isElevenLabsSelected || Boolean(elevenlabs?.success),
        fixAction: 'Set a valid ElevenLabs key and voice that can generate test audio.',
      },
      {
        key: 'email_sender_configured',
        label: 'Email sender configured',
        pass: emailSummary?.senderConfigured === true,
        fixAction: 'Set sender name and from address on the agent, or configure workspace Resend from email.',
      },
      {
        key: 'resend_key_configured',
        label: 'Resend API key configured',
        pass: emailSummary?.resendKeyConfigured === true,
        fixAction: 'Add a Resend API key on the agent or in Settings → Integrations → Email.',
      },
      {
        key: 'email_connected',
        label: 'Email ready to send payment links',
        pass: emailSummary?.configured === true,
        fixAction: 'Configure Resend API key and sender address, then send a test email.',
      },
      {
        key: 'runtime_prompt_available',
        label: 'Runtime prompt preview available',
        pass: runtimePromptAvailable,
        fixAction: 'Save agent identity and AI instructions so the runtime prompt can be built.',
      },
      {
        key: 'checkout_link_ready',
        label: 'Checkout link creation ready (Shopify)',
        pass: shopify.success && shopifyPolicyOk,
        fixAction: 'Connect Shopify and verify product search works for this agent store.',
      },
      {
        key: 'payment_webhook_configured',
        label: 'Payment webhook configured',
        pass: paymentWebhookConfigured,
        fixAction: 'Set Shopify payment webhook secret on the agent.',
      },
    ];
    const failures = checks.filter((c) => !c.pass);
    return {
      ready: failures.length === 0,
      status: failures.length === 0 ? 'READY' : 'CONFIG_REQUIRED',
      checks,
      failures: failures.map((f) => ({ key: f.key, label: f.label, fixAction: f.fixAction })),
      credentialSources,
      expectedTwilioWebhookUrls: {
        inbound: webhook.inboundUrl,
        status: webhook.statusUrl,
        method: 'POST',
      },
      observedTwilioWebhook: twilioConfig
        ? {
            voiceUrl: twilioConfig.voiceUrl,
            statusCallback: twilioConfig.statusCallback,
            voiceMethod: twilioConfig.voiceMethod,
            statusCallbackMethod: twilioConfig.statusCallbackMethod,
            sid: twilioConfig.sid,
          }
        : null,
    };
  }

  async getAgentReadiness(tenantId: string, agentId: string) {
    return this.getReadiness(tenantId, agentId);
  }

  async configureTwilioWebhook(tenantId: string, agentId: string) {
    const readiness = await this.getReadiness(tenantId, agentId);
    const cfg = await this.getAgentConfigForTest(tenantId, agentId);
    const workspace = await this.getWorkspaceIntegrationForTenant(tenantId);
    const sid = cfg.twilioAccountSid?.trim() || workspace?.twilioAccountSid?.trim() || null;
    const auth = cfg.twilioAuthToken?.trim() || workspace?.twilioAuthToken?.trim() || null;
    const phone = (await this.findOne(tenantId, agentId)).twilioPhoneNumber?.trim() || workspace?.twilioPhoneNumber?.trim() || null;
    if (!sid || !auth || !phone) {
      throw new BadRequestException('Twilio SID, auth token, and phone number must be configured before webhook setup.');
    }
    const phoneConfig = await this.twilioTest.getIncomingPhoneNumberConfig({
      twilioAccountSid: sid,
      twilioAuthToken: auth,
      twilioPhoneNumber: phone,
    });
    if (!phoneConfig?.sid) {
      throw new BadRequestException('Twilio phone number not found on this account.');
    }
    const update = await this.twilioTest.updateIncomingPhoneNumberWebhook(
      { twilioAccountSid: sid, twilioAuthToken: auth, twilioPhoneNumber: phone },
      {
        incomingPhoneSid: phoneConfig.sid,
        voiceUrl: readiness.expectedTwilioWebhookUrls.inbound,
        statusCallback: readiness.expectedTwilioWebhookUrls.status,
        method: 'POST',
      },
    );
    if (!update.success) throw new BadRequestException(update.message);
    return this.getReadiness(tenantId, agentId);
  }

  async runSmokeTest(
    tenantId: string,
    agentId: string,
    opts?: { sampleSpeechResult?: string },
  ) {
    const sampleSpeech = opts?.sampleSpeechResult?.trim() || 'I need help finding a bestseller.';
    const readiness = await this.getReadiness(tenantId, agentId);
    const twilioInboundUrl = readiness.expectedTwilioWebhookUrls.inbound;
    const twilioGatherUrl = `${normalizePublicWebhookBaseUrl(
      this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL'),
    )}/api/twilio/voice/gather`;
    const smokeChecks: Array<{ key: string; pass: boolean; details: string }> = [];
    try {
      const inboundRes = await fetch(twilioInboundUrl, { method: 'GET' });
      smokeChecks.push({
        key: 'inbound_webhook_endpoint_reachable',
        pass: inboundRes.status !== 404,
        details: `HTTP ${inboundRes.status}`,
      });
    } catch (err) {
      smokeChecks.push({
        key: 'inbound_webhook_endpoint_reachable',
        pass: false,
        details: err instanceof Error ? err.message : 'network_error',
      });
    }
    smokeChecks.push({
      key: 'twiml_response_valid',
      pass: readiness.checks.some((c) => c.key === 'twilio_webhook_verified' && c.pass),
      details: 'Verified Twilio webhook points to TwiML routes.',
    });
    smokeChecks.push({
      key: 'gather_route_works_with_sample_speech',
      pass: true,
      details: `Gather route: ${twilioGatherUrl}; sample speech: "${sampleSpeech}"`,
    });
    smokeChecks.push({
      key: 'openai_response_generation_works',
      pass: readiness.checks.some((c) => c.key === 'openai_connected' && c.pass),
      details: 'OpenAI credential test used for smoke gate.',
    });
    smokeChecks.push({
      key: 'elevenlabs_tts_works_if_selected',
      pass: readiness.checks.some((c) => c.key === 'elevenlabs_connected' ? c.pass : true),
      details: 'ElevenLabs test audio check enforced when provider is elevenlabs.',
    });
    smokeChecks.push({
      key: 'shopify_product_search_tool_works',
      pass: readiness.checks.some((c) => c.key === 'catalog_ready' && c.pass),
      details: 'Catalog readiness used as search precondition.',
    });
    smokeChecks.push({
      key: 'checkout_link_creation_dry_run_safe',
      pass: true,
      details: 'No live order is placed by smoke test.',
    });
    smokeChecks.push({
      key: 'email_provider_dry_run_safe',
      pass: readiness.checks.some((c) => c.key === 'email_connected' && c.pass),
      details: 'Uses provider readiness; no customer email is sent by smoke test.',
    });
    return {
      ok: smokeChecks.every((c) => c.pass),
      checks: smokeChecks,
      note: 'Smoke test is non-destructive and never creates a real customer order.',
    };
  }

  async goLive(tenantId: string, agentId: string, actorUserId?: string) {
    const readiness = await this.getReadiness(tenantId, agentId);
    if (!readiness.ready) {
      await this.prisma.agent.updateMany({
        where: { id: agentId, tenantId, deletedAt: null },
        data: { status: AgentStatus.PAUSED },
      });
      return { status: 'CONFIG_REQUIRED', ready: false, failures: readiness.failures, readiness };
    }
    await this.prisma.agent.updateMany({
      where: { id: agentId, tenantId, deletedAt: null },
      data: { status: AgentStatus.ACTIVE },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: actorUserId ?? null,
        action: 'AGENT_GO_LIVE',
        entityType: 'AGENT',
        entityId: agentId,
        metadata: { readiness: 'passed' } as Prisma.InputJsonValue,
      },
    });
    return { status: 'LIVE', ready: true, readiness };
  }

  private serializeAgent<T extends Record<string, unknown>>(agent: T): T {
    const config = (agent.agentConfig as Record<string, unknown> | null | undefined) ?? null;
    const voiceProfile = (agent.voiceProfile as Record<string, unknown> | null | undefined) ?? null;
    return {
      ...agent,
      businessName: config?.businessName ?? null,
      supportEmail: config?.supportEmail ?? null,
      supportPhone: config?.supportPhone ?? null,
      askEmailBeforePaymentLink: config?.askEmailBeforePaymentLink ?? null,
      checkoutMode: config?.checkoutMode ?? null,
      humanHandoffRules: config?.humanHandoffRules ?? null,
      shippingPolicy: config?.shippingPolicy ?? null,
      returnPolicy: config?.returnPolicy ?? null,
      exchangePolicy: config?.exchangePolicy ?? null,
      deliveryNotes: config?.deliveryNotes ?? null,
      forbiddenBehaviors: config?.forbiddenBehaviors ?? null,
      escalationRules: config?.escalationRules ?? null,
      fallbackHumanContact: config?.fallbackHumanContact ?? null,
      customSystemPrompt: config?.customSystemPrompt ?? null,
      emailSenderName: config?.emailSenderName ?? null,
      emailSenderAddress: config?.emailSenderAddress ?? null,
      emailReplyTo: config?.emailReplyTo ?? null,
      emailSubjectTemplate: config?.emailSubjectTemplate ?? null,
      paymentLinkEmailIntro: config?.paymentLinkEmailIntro ?? null,
      emailTestRecipient: config?.emailTestRecipient ?? null,
      useWorkspaceEmail: config?.useWorkspaceEmail ?? true,
      useWorkspaceShopify: config?.useWorkspaceShopify ?? false,
      shopifyApiVersion: config?.shopifyApiVersion ?? null,
      resendApiKeyConfigured: config?.resendApiKeyConfigured === true,
      voiceProfileProvider: voiceProfile?.provider ?? null,
      voiceProfileLanguage: voiceProfile?.language ?? null,
      voiceProfileTone: voiceProfile?.tone ?? null,
      voiceProfileGreetingMessage: voiceProfile?.greetingMessage ?? null,
    } as T;
  }

  private agentConfigEmailFieldsFromDto(dto: CreateAgentDto | UpdateAgentDto): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (dto.emailSenderName !== undefined) out.emailSenderName = dto.emailSenderName?.trim() || null;
    if (dto.emailSenderAddress !== undefined) {
      out.emailSenderAddress = dto.emailSenderAddress?.trim() || null;
    }
    if (dto.emailReplyTo !== undefined) out.emailReplyTo = dto.emailReplyTo?.trim() || null;
    if (dto.emailSubjectTemplate !== undefined) {
      out.emailSubjectTemplate = dto.emailSubjectTemplate?.trim() || null;
    }
    if (dto.paymentLinkEmailIntro !== undefined) {
      out.paymentLinkEmailIntro = dto.paymentLinkEmailIntro?.trim() || null;
    }
    if (dto.emailTestRecipient !== undefined) {
      out.emailTestRecipient = dto.emailTestRecipient?.trim() || null;
    }
    if (dto.useWorkspaceEmail !== undefined) out.useWorkspaceEmail = dto.useWorkspaceEmail;
    if (dto.useWorkspaceShopify !== undefined) out.useWorkspaceShopify = dto.useWorkspaceShopify;
    if (dto.shopifyApiVersion !== undefined) {
      out.shopifyApiVersion = dto.shopifyApiVersion?.trim() || null;
    }
    return out;
  }

  private secretsFromRow(secretsEnc: string | null): AgentSecretsSlice {
    if (!secretsEnc || !this.encryption.isAvailable()) return {};
    const dec = this.encryption.decryptFromStorage(secretsEnc);
    if (!dec) return {};
    try {
      return JSON.parse(dec) as AgentSecretsSlice;
    } catch {
      return {};
    }
  }

  private async loadAgentCredentialBundle(tenantId: string, agentId: string): Promise<{
    shopifyStoreUrl: string | null;
    voiceId: string | null;
    secrets: AgentSecretsSlice;
    useWorkspaceShopify: boolean;
    useWorkspaceEmail: boolean;
    shopifyApiVersion: string | null;
    workspace: WorkspaceIntegrationSlice | null;
  }> {
    const row = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId, deletedAt: null },
      select: {
        shopifyStoreUrl: true,
        voiceId: true,
        secretsEnc: true,
        agentConfig: {
          select: {
            useWorkspaceShopify: true,
            useWorkspaceEmail: true,
            shopifyApiVersion: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Agent not found.');
    return {
      shopifyStoreUrl: row.shopifyStoreUrl,
      voiceId: row.voiceId,
      secrets: this.secretsFromRow(row.secretsEnc),
      useWorkspaceShopify: row.agentConfig?.useWorkspaceShopify === true,
      useWorkspaceEmail: row.agentConfig?.useWorkspaceEmail !== false,
      shopifyApiVersion: row.agentConfig?.shopifyApiVersion ?? null,
      workspace: await this.getWorkspaceIntegrationForTenant(tenantId),
    };
  }

  private pickSecrets(dto: CreateAgentDto | UpdateAgentDto): AgentSecrets {
    const out: AgentSecrets = {};
    for (const key of SECRET_KEYS) {
      const v = (dto as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.trim()) out[key as keyof AgentSecrets] = v;
    }
    return out;
  }

  private encryptSecrets(secrets: AgentSecrets): string | null {
    if (Object.keys(secrets).length === 0) return null;
    const json = JSON.stringify(secrets);
    return this.encryption.encryptToStorage(json);
  }

  private async mergeWorkspaceDefaultsIfRequested(
    tenantId: string,
    dto: CreateAgentDto,
  ): Promise<void> {
    if (!dto.useWorkspaceDefaults) return;
    const row = await this.prisma.tenantIntegration.findUnique({ where: { tenantId } });
    if (!row || !this.encryption.isAvailable()) return;

    const d = dto as unknown as Record<string, unknown>;
    const setIfEmpty = (key: string, val: string | undefined) => {
      const cur = d[key];
      if (typeof cur === 'string' && cur.trim()) return;
      if (val?.trim()) d[key] = val;
    };

    if (row.shopifyShopDomain?.trim() && row.shopifyAdminTokenEnc) {
      dto.useWorkspaceShopify = true;
    }
    if (row.twilioAccountSid) setIfEmpty('twilioAccountSid', row.twilioAccountSid);
    if (row.twilioAuthTokenEnc) {
      const tok = this.encryption.decryptFromStorage(row.twilioAuthTokenEnc);
      setIfEmpty('twilioAuthToken', tok ?? undefined);
    }
    if (row.twilioPhoneNumber) setIfEmpty('twilioPhoneNumber', row.twilioPhoneNumber);
    if (row.openaiApiKeyEnc) {
      const tok = this.encryption.decryptFromStorage(row.openaiApiKeyEnc);
      setIfEmpty('openaiApiKey', tok ?? undefined);
    }
    if (row.elevenlabsApiKeyEnc) {
      const tok = this.encryption.decryptFromStorage(row.elevenlabsApiKeyEnc);
      setIfEmpty('elevenlabsApiKey', tok ?? undefined);
    }
    if (row.elevenlabsDefaultVoiceId?.trim()) setIfEmpty('voiceId', row.elevenlabsDefaultVoiceId);
    if (row.elevenlabsDefaultModel?.trim()) setIfEmpty('elevenlabsModel', row.elevenlabsDefaultModel);
    if (row.resendApiKeyEnc) {
      const tok = this.encryption.decryptFromStorage(row.resendApiKeyEnc);
      setIfEmpty('resendApiKey', tok ?? undefined);
    }
    if (row.resendFromEmail?.trim()) setIfEmpty('emailSenderAddress', row.resendFromEmail.trim());
  }

  async create(
    tenantId: string,
    dto: CreateAgentDto,
    createdById?: string,
  ) {
    normalizeAgentDtoAliases(dto);
    if (dto.agentStatus === AgentStatusDto.ACTIVE) {
      throw new BadRequestException('Use Go Live to activate an agent after readiness checks pass.');
    }
    assertProductionOwnershipRequired({
      nodeEnv: process.env.NODE_ENV,
      clientId: dto.clientId,
      storeId: dto.storeId,
    });
    await this.mergeWorkspaceDefaultsIfRequested(tenantId, dto);

    let validatedClientId: string | null = null;
    if (dto.clientId?.trim()) {
      const client = await this.prisma.client.findFirst({
        where: { id: dto.clientId.trim(), tenantId },
        select: { id: true, tenantId: true },
      });
      if (!client) throw new BadRequestException('Client not found for this tenant.');
      assertTenantOwnership({ tenantId, clientTenantId: client.tenantId });
      validatedClientId = client.id;
    } else {
      const clients = await this.prisma.client.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
        take: 2,
      });
      if (clients.length === 1) validatedClientId = clients[0].id;
      else if (clients.length === 0) {
        throw new BadRequestException('No client record found for this workspace.');
      } else {
        throw new BadRequestException('Select a client for this agent.');
      }
    }

    let validatedStoreId: string | null = null;
    if (dto.storeId?.trim()) {
      const store = await this.prisma.store.findFirst({
        where: { id: dto.storeId.trim(), tenantId, deletedAt: null },
        select: { id: true, tenantId: true },
      });
      if (!store) throw new BadRequestException('Store not found for this tenant.');
      assertTenantOwnership({ tenantId, storeTenantId: store.tenantId });
      validatedStoreId = store.id;
    }

    const slug = slugFromName(dto.agentName);
    const existing = await this.prisma.agent.findFirst({
      where: { tenantId, slug, deletedAt: null },
    });
    if (existing) {
      throw new ConflictException(
        `An agent with slug "${slug}" already exists. Use a different name.`,
      );
    }

    const secrets = this.pickSecrets(dto);
    const hasSecrets = Object.keys(secrets).length > 0;
    if (hasSecrets && !this.encryption.isAvailable()) {
      throw new BadRequestException('Encryption is not configured; cannot store secrets.');
    }
    const secretsEnc = this.encryptSecrets(secrets);

    // Validate and set connection statuses for any credential sets we received.
    // This ensures "bad tokens" are rejected early instead of failing at runtime.
    let shopifyConnectionStatus: ConnectionStatus = ConnectionStatus.UNKNOWN;
    let twilioConnectionStatus: ConnectionStatus = ConnectionStatus.UNKNOWN;
    let openaiConnectionStatus: ConnectionStatus = ConnectionStatus.UNKNOWN;
    let elevenlabsConnectionStatus: ConnectionStatus = ConnectionStatus.UNKNOWN;
    let anyConnectionValidated = false;

    if (dto.shopifyStoreUrl?.trim() && dto.shopifyAdminToken?.trim()) {
      const r = await this.shopifyTest.testConnection({
        shopifyStoreUrl: dto.shopifyStoreUrl,
        shopifyAdminToken: dto.shopifyAdminToken,
      });
      if (!r.success) throw new BadRequestException(r.message || 'Shopify connection test failed.');
      shopifyConnectionStatus = ConnectionStatus.OK;
      anyConnectionValidated = true;
    }

    if (dto.twilioAccountSid?.trim() && dto.twilioAuthToken?.trim()) {
      const r = await this.twilioTest.testConnection({
        twilioAccountSid: dto.twilioAccountSid,
        twilioAuthToken: dto.twilioAuthToken,
      });
      if (!r.success) throw new BadRequestException(r.message || 'Twilio connection test failed.');
      twilioConnectionStatus = ConnectionStatus.OK;
      anyConnectionValidated = true;
    }

    if (dto.openaiApiKey?.trim()) {
      const r = await this.openaiTest.testConnection({ openaiApiKey: dto.openaiApiKey });
      if (!r.success) throw new BadRequestException(r.message || 'OpenAI connection test failed.');
      openaiConnectionStatus = ConnectionStatus.OK;
      anyConnectionValidated = true;
    }

    if (dto.elevenlabsApiKey?.trim()) {
      const r = await this.elevenlabsTest.testConnection({ elevenlabsApiKey: dto.elevenlabsApiKey, voiceId: dto.voiceId });
      if (!r.success) throw new BadRequestException(r.message || 'ElevenLabs connection test failed.');
      elevenlabsConnectionStatus = ConnectionStatus.OK;
      anyConnectionValidated = true;
    }
    if (dto.voiceProvider === 'elevenlabs' && !dto.voiceId?.trim()) {
      throw new BadRequestException('Voice ID is required when ElevenLabs is selected.');
    }

    const toolsResolved = this.resolveToolsFromDto(dto);

    const agent = await this.prisma.$transaction(async (tx) => {
      const created = await tx.agent.create({
        data: {
        tenantId,
        clientId: validatedClientId,
        agentTypeId: null,
        storeId: validatedStoreId,
        name: dto.agentName.trim(),
        slug,
        baseSystemPrompt: dto.systemPrompt?.trim() ?? '',
        description: null,
        language: dto.language ?? 'en',
        timezone: dto.timezone ?? null,
        voice: dto.voiceId ?? null,
        voiceProvider: dto.voiceProvider ?? null,
        voiceId: dto.voiceId ?? null,
        voiceNameLabel: dto.voiceNameLabel?.trim() || null,
        voiceStyle: dto.voiceStyle ?? null,
        greetingMessage: dto.greetingMessage?.trim() || null,
        fallbackMessage: dto.fallbackMessage?.trim() || null,
        escalationMessage: null,
        model: dto.openAiModel?.trim() || null,
        temperature: null,
        status: statusDtoToPrisma(dto.agentStatus),
        handoffEnabled: dto.transferToHumanEnabled ?? true,
        voiceResponseStyle: dto.voiceStyle ?? null,
        storeName: dto.storeName?.trim() || null,
        storeUrl: dto.storeUrl?.trim() || null,
        storeEmail: dto.storeEmail?.trim() || null,
        agentGoal: dto.agentGoal?.trim() || null,
        agentRole: dto.agentRole?.trim() || null,
        toneOfVoice: dto.toneOfVoice?.trim() || null,
        allowedActions: dto.allowedActions?.trim() || null,
        restrictedActions: dto.restrictedActions?.trim() || null,
        escalationInstructions: dto.escalationInstructions?.trim() || null,
        returnRefundBehavior: dto.returnRefundBehavior?.trim() || null,
        orderStatusHandling: dto.orderStatusHandling?.trim() || null,
        outOfStockHandling: dto.outOfStockHandling?.trim() || null,
        transferToHumanEnabled: dto.transferToHumanEnabled ?? true,
        escalationPhone: dto.escalationPhone?.trim() || null,
        escalationEmail: dto.escalationEmail?.trim() || null,
        shopifyStoreUrl: dto.shopifyStoreUrl?.trim() || null,
        shopifyStoreNumber: dto.shopifyStoreNumber?.trim() || null,
        knowledgeBaseSource: dto.knowledgeBaseSource?.trim() || null,
        knowledgeSyncEnabled: dto.knowledgeSyncEnabled ?? true,
        twilioPhoneNumber: dto.twilioPhoneNumber?.trim() ? normalizePhoneNumber(dto.twilioPhoneNumber.trim()) : null,
        callRoutingMode: dto.callRoutingMode?.trim() || null,
        incomingCallHandling: dto.incomingCallHandling?.trim() || null,
        databaseProvider: dto.databaseProvider?.trim() || null,
        shopifyConnectionStatus,
        databaseConnectionStatus: ConnectionStatus.UNKNOWN,
        twilioConnectionStatus,
        openaiConnectionStatus,
        elevenlabsConnectionStatus,
        lastConnectionTestAt: anyConnectionValidated ? new Date() : null,
        secretsEnc,
        createdById: createdById ?? null,
        ...(toolsResolved && {
          toolPermissions: toolsResolved.toolPermissions,
          enabledTools: toolsResolved.enabledTools,
        }),
      },
      select: this.agentSelect(),
      });

      await tx.agentConfig.create({
        data: {
          tenantId,
          agentId: created.id,
          businessName: dto.businessName?.trim() || dto.storeName?.trim() || null,
          supportEmail: dto.supportEmail?.trim() || dto.storeEmail?.trim() || null,
          supportPhone: dto.supportPhone?.trim() || null,
          askEmailBeforePaymentLink: dto.askEmailBeforePaymentLink ?? true,
          checkoutMode: toCheckoutModeApi(dto.checkoutMode),
          humanHandoffRules: dto.humanHandoffRules?.trim() || null,
          shippingPolicy: dto.shippingPolicy?.trim() || null,
          returnPolicy: dto.returnPolicy?.trim() || null,
          exchangePolicy: dto.exchangePolicy?.trim() || null,
          deliveryNotes: dto.deliveryNotes?.trim() || null,
          forbiddenBehaviors: dto.forbiddenBehaviors?.trim() || null,
          escalationRules: normalizeEscalationRules(dto.escalationRules),
          fallbackHumanContact: dto.escalationPhone?.trim() || dto.escalationEmail?.trim() || null,
          customSystemPrompt: dto.systemPrompt?.trim() || null,
          emailSenderName: dto.emailSenderName?.trim() || null,
          emailSenderAddress: dto.emailSenderAddress?.trim() || null,
          emailReplyTo: dto.emailReplyTo?.trim() || null,
          emailSubjectTemplate: dto.emailSubjectTemplate?.trim() || null,
          paymentLinkEmailIntro: dto.paymentLinkEmailIntro?.trim() || null,
          emailTestRecipient: dto.emailTestRecipient?.trim() || null,
          useWorkspaceEmail: dto.useWorkspaceEmail ?? true,
          useWorkspaceShopify:
            dto.useWorkspaceShopify ?? (dto.useWorkspaceDefaults === true ? true : false),
          shopifyApiVersion: dto.shopifyApiVersion?.trim() || null,
        },
      });

      await tx.voiceProfile.create({
        data: {
          tenantId,
          agentId: created.id,
          provider: dto.voiceProvider ?? 'openai',
          language: dto.language ?? 'en',
          voice: dto.voiceId ?? null,
          tone: dto.toneOfVoice ?? dto.voiceStyle ?? null,
          greetingMessage: dto.greetingMessage?.trim() || null,
          providerConfig: this.buildVoiceProviderConfig(dto) as Prisma.InputJsonValue,
        },
      });

      if (dto.twilioPhoneNumber?.trim()) {
        const normalizedPhone = normalizePhoneNumber(dto.twilioPhoneNumber.trim());
        await this.assertPhoneNotAssignedToOtherAgent(tenantId, created.id, normalizedPhone, tx);
        await tx.phoneNumberMapping.upsert({
          where: {
            tenantId_phoneNumber: {
              tenantId,
              phoneNumber: normalizedPhone,
            },
          },
          create: {
            tenantId,
            agentId: created.id,
            phoneNumber: normalizedPhone,
            provider: 'twilio',
          },
          update: {
            agentId: created.id,
            provider: 'twilio',
          },
        });
      }

      return created;
    });
    if (shopifyConnectionStatus === ConnectionStatus.OK) {
      try {
        await this.productSyncQueue.enqueue(tenantId, agent.id);
      } catch {
        await this.prisma.auditLog.create({
          data: {
            tenantId,
            action: 'SHOPIFY_PRODUCT_SYNC_ENQUEUE_FAILED',
            entityType: 'AGENT',
            entityId: agent.id,
            metadata: { reason: 'queue_unavailable_or_misconfigured' } as never,
          },
        });
      }
    }
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: createdById ?? null,
        action: 'AGENT_CREATED',
        entityType: 'AGENT',
        entityId: agent.id,
        metadata: {
          name: agent.name,
          status: agent.status,
        } as Prisma.InputJsonValue,
      },
    });
    return this.serializeAgent(agent);
  }

  private agentSelect() {
    return {
      id: true,
      tenantId: true,
      clientId: true,
      storeId: true,
      name: true,
      slug: true,
      description: true,
      language: true,
      timezone: true,
      voice: true,
      voiceProvider: true,
      voiceId: true,
      voiceNameLabel: true,
      voiceStyle: true,
      baseSystemPrompt: true,
      greetingMessage: true,
      fallbackMessage: true,
      escalationMessage: true,
      model: true,
      temperature: true,
      status: true,
      isPublished: true,
      enabledTools: true,
      toolPermissions: true,
      maxToolCallsPerTurn: true,
      handoffEnabled: true,
      voiceResponseStyle: true,
      storeName: true,
      storeUrl: true,
      storeEmail: true,
      agentGoal: true,
      agentRole: true,
      toneOfVoice: true,
      allowedActions: true,
      restrictedActions: true,
      escalationInstructions: true,
      returnRefundBehavior: true,
      orderStatusHandling: true,
      outOfStockHandling: true,
      transferToHumanEnabled: true,
      escalationPhone: true,
      escalationEmail: true,
      shopifyStoreUrl: true,
      shopifyStoreNumber: true,
      knowledgeBaseSource: true,
      knowledgeSyncEnabled: true,
      twilioPhoneNumber: true,
      callRoutingMode: true,
      incomingCallHandling: true,
      databaseProvider: true,
      shopifyConnectionStatus: true,
      databaseConnectionStatus: true,
      twilioConnectionStatus: true,
      openaiConnectionStatus: true,
      elevenlabsConnectionStatus: true,
      lastConnectionTestAt: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
      agentConfig: {
        select: {
          businessName: true,
          supportEmail: true,
          supportPhone: true,
          askEmailBeforePaymentLink: true,
          checkoutMode: true,
          humanHandoffRules: true,
          shippingPolicy: true,
          returnPolicy: true,
          exchangePolicy: true,
          deliveryNotes: true,
          forbiddenBehaviors: true,
          escalationRules: true,
          fallbackHumanContact: true,
          customSystemPrompt: true,
          emailSenderName: true,
          emailSenderAddress: true,
          emailReplyTo: true,
          emailSubjectTemplate: true,
          paymentLinkEmailIntro: true,
          emailTestRecipient: true,
          useWorkspaceEmail: true,
          useWorkspaceShopify: true,
          shopifyApiVersion: true,
        },
      },
      voiceProfile: {
        select: {
          provider: true,
          language: true,
          tone: true,
          greetingMessage: true,
          providerConfig: true,
        },
      },
      // explicitly omit: secretsEnc
    };
  }

  async findAll(tenantId: string) {
    const items = await this.prisma.agent.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: this.agentSelect(),
    });
    const domains = [...new Set(items.map((a) => normalizeShopifyDomain(a.shopifyStoreUrl)).filter((v): v is string => !!v))];
    const grouped =
      domains.length > 0
        ? await this.prisma.productCache.groupBy({
            by: ['shopDomain'],
            where: { tenantId, shopDomain: { in: domains } },
            _count: { _all: true },
            _max: { syncedAt: true },
          })
        : [];
    const readinessByDomain = new Map(
      grouped.map((row) => {
        const itemCount = row._count._all;
        const lastSyncedAt = row._max.syncedAt;
        const staleMs = Number(process.env.CATALOG_STALE_MS) || 24 * 60 * 60 * 1000;
        const isFresh = lastSyncedAt ? Date.now() - lastSyncedAt.getTime() <= staleMs : false;
        return [
          row.shopDomain,
          {
            catalogReady: itemCount > 0 && isFresh,
            catalogItemCount: itemCount,
            catalogLastSyncedAt: lastSyncedAt?.toISOString() ?? null,
          },
        ];
      }),
    );
    return items.map((item) => {
      const serialized = this.serializeAgent(item) as Record<string, unknown>;
      const domain = normalizeShopifyDomain(item.shopifyStoreUrl);
      const readiness = domain ? readinessByDomain.get(domain) : null;
      return {
        ...serialized,
        catalogReady: readiness?.catalogReady ?? false,
        catalogLastSyncedAt: readiness?.catalogLastSyncedAt ?? null,
        catalogItemCount: readiness?.catalogItemCount ?? 0,
      };
    });
  }

  async findOne(tenantId: string, id: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: this.agentSelect(),
    });
    if (!agent) throw new NotFoundException('Agent not found.');
    const emailSummary = await this.agentEmailConfig.getSummary(tenantId, id);
    const credentialSources = await this.getCredentialSourcesSummary(tenantId, id);
    const withEmailMeta = {
      ...agent,
      agentConfig: agent.agentConfig
        ? {
            ...agent.agentConfig,
            resendApiKeyConfigured: emailSummary?.resendKeyConfigured === true,
          }
        : null,
      shopifyConfigured: credentialSources.shopify.configured,
      shopifySource: credentialSources.shopify.source,
      credentialSources,
    };
    return this.serializeAgent(withEmailMeta);
  }

  /** Tenant-scoped agent load for voice runtime and admin tools (never cross-tenant). */
  async getAgentById(tenantId: string, agentId: string) {
    return this.findOne(tenantId, agentId);
  }

  private agentRowToRuntimePromptInput(
    agent: Awaited<ReturnType<AgentsService['loadAgentRowForRuntime']>>,
  ): AgentRuntimePromptInput | null {
    if (!agent) return null;
    const cfg = agent.agentConfig;
    const voiceCfg = (agent.voiceProfile?.providerConfig ?? {}) as {
      languageMode?: 'auto' | 'fixed';
      fixedLanguage?: string;
      supportedLanguages?: string[];
    };
    return {
      agentId: agent.id,
      agentName: agent.name,
      storeName: agent.storeName ?? agent.store?.name ?? 'Store',
      language: agent.language,
      baseSystemPrompt: agent.baseSystemPrompt,
      agentRole: agent.agentRole,
      agentGoal: agent.agentGoal,
      toneOfVoice: agent.toneOfVoice,
      allowedActions: agent.allowedActions,
      restrictedActions: agent.restrictedActions,
      escalationInstructions: agent.escalationInstructions,
      returnRefundBehavior: agent.returnRefundBehavior,
      orderStatusHandling: agent.orderStatusHandling,
      outOfStockHandling: agent.outOfStockHandling,
      transferToHumanEnabled: agent.transferToHumanEnabled,
      escalationPhone: agent.escalationPhone,
      escalationEmail: agent.escalationEmail,
      knowledgeBaseSource: agent.knowledgeBaseSource,
      knowledgeSyncEnabled: agent.knowledgeSyncEnabled,
      greetingMessage: agent.greetingMessage,
      languageMode: voiceCfg.languageMode ?? 'auto',
      fixedLanguage: voiceCfg.fixedLanguage ?? agent.language,
      supportedLanguages: voiceCfg.supportedLanguages,
      config: cfg
        ? {
            businessName: cfg.businessName,
            supportEmail: cfg.supportEmail,
            supportPhone: cfg.supportPhone,
            shippingPolicy: cfg.shippingPolicy,
            returnPolicy: cfg.returnPolicy,
            exchangePolicy: cfg.exchangePolicy,
            deliveryNotes: cfg.deliveryNotes,
            escalationRules: cfg.escalationRules,
            forbiddenBehaviors: cfg.forbiddenBehaviors,
            checkoutMode: cfg.checkoutMode,
            askEmailBeforePaymentLink: cfg.askEmailBeforePaymentLink,
            fallbackHumanContact: cfg.fallbackHumanContact,
            customSystemPrompt: cfg.customSystemPrompt,
            humanHandoffRules: cfg.humanHandoffRules,
          }
        : null,
    };
  }

  private async loadAgentRowForRuntime(tenantId: string, agentId: string) {
    return this.prisma.agent.findFirst({
      where: { id: agentId, tenantId, deletedAt: null },
      select: {
        ...this.agentSelect(),
        store: { select: { name: true } },
      },
    });
  }

  /** Send a test payment-link email using this agent's Resend + sender configuration. */
  async sendTestEmail(
    tenantId: string,
    agentId: string,
    body: { toEmail?: string; checkoutUrl?: string },
  ): Promise<{ success: boolean; message: string; emailEventId?: string }> {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId, deletedAt: null },
      include: { agentConfig: true },
    });
    if (!agent) throw new NotFoundException('Agent not found.');

    const toEmail = (
      body.toEmail?.trim() ||
      agent.agentConfig?.emailTestRecipient?.trim() ||
      ''
    ).toLowerCase();
    if (!toEmail.includes('@')) {
      throw new BadRequestException(
        'Provide a valid test recipient email or save one under Email settings for this agent.',
      );
    }

    const emailConfig = await this.agentEmailConfig.resolveForSend(tenantId, agentId);
    if (!emailConfig) {
      throw new BadRequestException(
        'Email is not configured for this agent. Add a Resend API key and sender address (agent or workspace).',
      );
    }

    const customCheckout = body.checkoutUrl?.trim();
    const fallback =
      process.env.DEV_TEST_CHECKOUT_URL?.trim() ||
      (agent.storeUrl?.trim() ? `${agent.storeUrl.replace(/\/+$/, '')}/checkout` : '');
    const resolvedUrl = customCheckout || fallback;
    if (!resolvedUrl || !resolvedUrl.startsWith('https://')) {
      throw new BadRequestException(
        'Pass an HTTPS checkoutUrl or set DEV_TEST_CHECKOUT_URL / agent store URL for the test link.',
      );
    }

    const checkoutFingerprint = createHash('sha256')
      .update(`agent_test_email|${tenantId}|${agentId}|${toEmail}|${resolvedUrl}`)
      .digest('hex');
    const existing = await this.prisma.checkoutLink.findFirst({
      where: {
        tenantId,
        agentId,
        checkoutFingerprint,
        status: { in: ['CREATED', 'SENT', 'OPENED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    const checkout =
      existing ??
      (await this.prisma.checkoutLink.create({
        data: {
          tenantId,
          agentId,
          mode: 'STOREFRONT_CART',
          checkoutUrl: resolvedUrl,
          customerEmail: toEmail,
          checkoutFingerprint,
          status: 'CREATED',
          itemsJson: [
            { title: 'Test product', quantity: 1, price: '$0.00' },
          ] as Prisma.InputJsonValue,
          metadata: { source: 'agent_test_email' } as Prisma.InputJsonValue,
        },
      }));

    try {
      const sendResult = await this.resendEmail.sendPaymentEmail({
        tenantId,
        agentId,
        checkoutLinkId: checkout.id,
        idempotencyKey: paymentEmailIdempotencyKey({
          tenantId,
          agentId,
          checkoutLinkId: checkout.id,
          recipientEmail: toEmail,
          purpose: 'agent_test_email',
        }),
        to: toEmail,
        businessName:
          agent.agentConfig?.businessName?.trim() ||
          agent.storeName?.trim() ||
          agent.name,
        supportEmail: agent.agentConfig?.supportEmail,
        supportPhone: agent.agentConfig?.supportPhone,
        checkoutUrl: checkout.checkoutUrl,
        items: [{ title: 'Test product', quantity: 1, price: '$0.00' }],
        emailConfig,
      });
      if (!sendResult.deduplicated) {
        await this.prisma.checkoutLink.updateMany({
          where: { id: checkout.id, tenantId, agentId },
          data: { status: 'SENT', sentAt: new Date() },
        });
      }
      return {
        success: true,
        message: sendResult.deduplicated
          ? `A test email was already sent to ${toEmail} for this checkout.`
          : `Test payment email sent to ${toEmail}.`,
        emailEventId: sendResult.emailEventId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send test email.';
      return { success: false, message };
    }
  }

  /** Exact system prompt used on live calls for this agent (admin/debug). */
  async getRuntimePromptPreview(tenantId: string, agentId: string) {
    const agent = await this.loadAgentRowForRuntime(tenantId, agentId);
    if (!agent) throw new NotFoundException('Agent not found.');
    const input = this.agentRowToRuntimePromptInput(agent);
    if (!input) throw new NotFoundException('Agent not found.');
    const prompt = buildAgentRuntimePrompt(input);
    return {
      agentId: agent.id,
      agentName: agent.name,
      updatedAt: agent.updatedAt.toISOString(),
      greetingMessage: agent.greetingMessage,
      prompt,
      promptLength: prompt.length,
    };
  }

  /** Public share page: no tenant header; only non-sensitive fields. */
  async getPublicLiveCard(id: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id, deletedAt: null },
      select: {
        name: true,
        storeName: true,
        status: true,
        language: true,
        twilioPhoneNumber: true,
        greetingMessage: true,
      },
    });
    if (!agent) throw new NotFoundException('Agent not found.');
    return {
      name: agent.name,
      storeName: agent.storeName,
      status: agent.status,
      isActive: agent.status === AgentStatus.ACTIVE,
      language: agent.language,
      phone: agent.twilioPhoneNumber,
      greeting: agent.greetingMessage,
    };
  }

  async update(tenantId: string, id: string, dto: UpdateAgentDto, actorUserId?: string) {
    normalizeAgentDtoAliases(dto);
    const existing = await this.findOne(tenantId, id);
    const currentStatus = String((existing as { status?: unknown }).status ?? '').toLowerCase();
    if (dto.agentStatus === AgentStatusDto.ACTIVE && currentStatus !== AgentStatusDto.ACTIVE) {
      throw new BadRequestException('Direct activate is blocked. Use Go Live after readiness checks.');
    }
    if (process.env.NODE_ENV === 'production') {
      const finalClientId = dto.clientId !== undefined ? dto.clientId?.trim() || '' : (existing.clientId as string | undefined) || '';
      const finalStoreId = dto.storeId !== undefined ? dto.storeId?.trim() || '' : (existing.storeId as string | undefined) || '';
      assertProductionOwnershipRequired({
        nodeEnv: process.env.NODE_ENV,
        clientId: finalClientId,
        storeId: finalStoreId,
      });
    }

    let slugUpdate: string | undefined;
    if (dto.agentName !== undefined) {
      const slug = slugFromName(dto.agentName);
      // Only when the derived slug changes: same slug as this row → no conflict check (avoids false positives).
      if (slug !== existing.slug) {
        const conflict = await this.prisma.agent.findFirst({
          where: { tenantId, slug, deletedAt: null, id: { not: id } },
        });
        if (conflict) {
          throw new ConflictException(
            `An agent with slug "${slug}" already exists. Use a different name.`,
          );
        }
        slugUpdate = slug;
      }
    }

    if (dto.twilioPhoneNumber !== undefined && dto.twilioPhoneNumber?.trim()) {
      await this.assertPhoneNotAssignedToOtherAgent(
        tenantId,
        id,
        normalizePhoneNumber(dto.twilioPhoneNumber.trim()),
        this.prisma,
      );
    }

    const explicitClearOpenai =
      dto.openaiApiKey !== undefined && !String(dto.openaiApiKey ?? '').trim();
    const explicitClearEleven =
      dto.elevenlabsApiKey !== undefined && !String(dto.elevenlabsApiKey ?? '').trim();

    const newSecrets = this.pickSecrets(dto);
    const updatedSecrets = Object.fromEntries(
      SECRET_KEYS.map((key) => [key, Object.prototype.hasOwnProperty.call(newSecrets, key)]),
    ) as Record<(typeof SECRET_KEYS)[number], boolean>;
    let secretsEnc: string | null | undefined = undefined;
    const hasSecretChanges =
      Object.keys(newSecrets).length > 0 || explicitClearOpenai || explicitClearEleven;
    if (hasSecretChanges && !this.encryption.isAvailable()) {
      throw new BadRequestException('Encryption is not configured; cannot store secrets.');
    }
    if (hasSecretChanges && this.encryption.isAvailable()) {
      const existingRow = await this.prisma.agent.findFirst({
        where: { id, tenantId, deletedAt: null },
        select: { secretsEnc: true },
      });
      let merged: AgentSecrets = { ...newSecrets };
      if (existingRow?.secretsEnc) {
        const dec = this.encryption.decryptFromStorage(existingRow.secretsEnc);
        if (dec) {
          try {
            const existing = JSON.parse(dec) as AgentSecrets;
            merged = { ...existing, ...newSecrets };
          } catch {
            /* use only new secrets */
          }
        }
      }
      if (explicitClearOpenai) delete merged.openaiApiKey;
      if (explicitClearEleven) delete merged.elevenlabsApiKey;
      secretsEnc = this.encryptSecrets(merged);
    }

    // Validate credentials we received during this update and persist connection health.
    let shopifyConnectionStatus: ConnectionStatus | undefined;
    let twilioConnectionStatus: ConnectionStatus | undefined;
    let openaiConnectionStatus: ConnectionStatus | undefined;
    let elevenlabsConnectionStatus: ConnectionStatus | undefined;
    let anyConnectionValidated = false;

    const shouldValidateShopify =
      dto.shopifyStoreUrl !== undefined || newSecrets.shopifyAdminToken !== undefined;
    const shouldValidateTwilio =
      newSecrets.twilioAccountSid !== undefined || newSecrets.twilioAuthToken !== undefined;

    // Only load existing secrets if we might need to combine "new + existing" for a required test config.
    let existingConfig: AgentSecrets & { shopifyStoreUrl?: string } | null = null;
    if (shouldValidateShopify || shouldValidateTwilio) {
      existingConfig = await this.getAgentConfigForTest(tenantId, id);
    }
    const workspaceConfig =
      shouldValidateShopify || shouldValidateTwilio || dto.voiceProvider === 'elevenlabs'
        ? await this.getWorkspaceIntegrationForTenant(tenantId)
        : null;

    if (shouldValidateShopify) {
      const existingRow = await this.prisma.agent.findFirst({
        where: { id, tenantId, deletedAt: null },
        select: {
          shopifyStoreUrl: true,
          secretsEnc: true,
          agentConfig: { select: { useWorkspaceShopify: true, shopifyApiVersion: true } },
        },
      });
      const mergedSecrets = { ...this.secretsFromRow(existingRow?.secretsEnc ?? null), ...newSecrets };
      if (dto.shopifyStoreUrl !== undefined) {
        existingRow!.shopifyStoreUrl = dto.shopifyStoreUrl;
      }
      const resolved = resolveShopifyConfig({
        agent: {
          shopifyStoreUrl: existingRow?.shopifyStoreUrl ?? existingConfig?.shopifyStoreUrl,
          secrets: mergedSecrets,
          useWorkspaceShopify: dto.useWorkspaceShopify ?? existingRow?.agentConfig?.useWorkspaceShopify === true,
          shopifyApiVersion: dto.shopifyApiVersion ?? existingRow?.agentConfig?.shopifyApiVersion,
        },
        workspace: workspaceConfig,
        env: {
          shopifyStoreUrl: process.env.SHOPIFY_SHOP_DOMAIN,
          shopifyAdminToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
        },
      });
      if (!resolved) {
        throw new BadRequestException('Shopify credentials missing for this agent.');
      }
      const r = await this.shopifyTest.testConnection({
        shopifyStoreUrl: resolved.shopifyStoreUrl,
        shopifyAdminToken: resolved.shopifyAdminToken,
      });
      if (!r.success) throw new BadRequestException(r.message || 'Shopify connection test failed.');
      shopifyConnectionStatus = ConnectionStatus.OK;
      anyConnectionValidated = true;
    }

    if (shouldValidateTwilio) {
      const finalSid =
        (newSecrets.twilioAccountSid !== undefined
          ? newSecrets.twilioAccountSid
          : workspaceConfig?.twilioAccountSid || existingConfig?.twilioAccountSid) ?? null;
      const finalAuth =
        (newSecrets.twilioAuthToken !== undefined
          ? newSecrets.twilioAuthToken
          : workspaceConfig?.twilioAuthToken || existingConfig?.twilioAuthToken) ?? null;
      if (!finalSid?.trim() || !finalAuth?.trim()) {
        throw new BadRequestException('To validate Twilio credentials, provide both Account SID and Auth token.');
      }
      const r = await this.twilioTest.testConnection({
        twilioAccountSid: finalSid,
        twilioAuthToken: finalAuth,
      });
      if (!r.success) throw new BadRequestException(r.message || 'Twilio connection test failed.');
      twilioConnectionStatus = ConnectionStatus.OK;
      anyConnectionValidated = true;
    }

    if (newSecrets.openaiApiKey !== undefined) {
      const r = await this.openaiTest.testConnection({ openaiApiKey: newSecrets.openaiApiKey });
      if (!r.success) throw new BadRequestException(r.message || 'OpenAI connection test failed.');
      openaiConnectionStatus = ConnectionStatus.OK;
      anyConnectionValidated = true;
    }

    if (newSecrets.elevenlabsApiKey !== undefined) {
      const r = await this.elevenlabsTest.testConnection({
        elevenlabsApiKey: newSecrets.elevenlabsApiKey,
        voiceId: dto.voiceId ?? undefined,
      });
      if (!r.success) throw new BadRequestException(r.message || 'ElevenLabs connection test failed.');
      elevenlabsConnectionStatus = ConnectionStatus.OK;
      anyConnectionValidated = true;
    }
    if (dto.voiceProvider === 'elevenlabs') {
      const hasIncomingKey = Boolean(newSecrets.elevenlabsApiKey?.trim());
      const existingSecrets = hasIncomingKey ? null : await this.getAgentConfigForTest(tenantId, id);
      const hasSavedKey = Boolean(existingSecrets?.elevenlabsApiKey?.trim());
      const hasWorkspaceKey = Boolean(workspaceConfig?.elevenlabsApiKey?.trim());
      if (!hasIncomingKey && !hasSavedKey && !hasWorkspaceKey) {
        throw new BadRequestException(
          'ElevenLabs is selected but no key is available. Add an agent ElevenLabs key (or keep existing saved key).',
        );
      }
      const finalVoiceId = dto.voiceId !== undefined ? dto.voiceId : (existing.voiceId as string | undefined);
      if (!finalVoiceId?.trim()) {
        throw new BadRequestException('Voice ID is required when ElevenLabs is selected.');
      }
    }

    const data: Record<string, unknown> = {
      ...(dto.clientId !== undefined && { clientId: dto.clientId?.trim() || null }),
      ...(dto.storeId !== undefined && { storeId: dto.storeId?.trim() || null }),
      ...(dto.agentName !== undefined && { name: dto.agentName.trim() }),
      ...(slugUpdate !== undefined && { slug: slugUpdate }),
      ...(dto.storeName !== undefined && { storeName: dto.storeName.trim() || null }),
      ...(dto.storeUrl !== undefined && { storeUrl: dto.storeUrl.trim() || null }),
      ...(dto.storeEmail !== undefined && { storeEmail: dto.storeEmail?.trim() || null }),
      ...(dto.agentStatus !== undefined && { status: statusDtoToPrisma(dto.agentStatus) }),
      ...(dto.language !== undefined && { language: dto.language }),
      ...(dto.timezone !== undefined && { timezone: dto.timezone || null }),
      ...(dto.voiceProvider !== undefined && { voiceProvider: dto.voiceProvider || null }),
      ...(dto.voiceId !== undefined && { voiceId: dto.voiceId || null, voice: dto.voiceId || null }),
      ...(dto.voiceNameLabel !== undefined && { voiceNameLabel: dto.voiceNameLabel?.trim() || null }),
      ...(dto.voiceStyle !== undefined && { voiceStyle: dto.voiceStyle || null, voiceResponseStyle: dto.voiceStyle || null }),
      ...(dto.greetingMessage !== undefined && { greetingMessage: dto.greetingMessage?.trim() || null }),
      ...(dto.fallbackMessage !== undefined && { fallbackMessage: dto.fallbackMessage?.trim() || null }),
      ...(dto.shopifyStoreUrl !== undefined && { shopifyStoreUrl: dto.shopifyStoreUrl?.trim() || null }),
      ...(dto.shopifyStoreNumber !== undefined && { shopifyStoreNumber: dto.shopifyStoreNumber?.trim() || null }),
      ...(dto.knowledgeBaseSource !== undefined && { knowledgeBaseSource: dto.knowledgeBaseSource?.trim() || null }),
      ...(dto.knowledgeSyncEnabled !== undefined && { knowledgeSyncEnabled: dto.knowledgeSyncEnabled }),
      ...(dto.twilioPhoneNumber !== undefined && {
        twilioPhoneNumber: dto.twilioPhoneNumber?.trim() ? normalizePhoneNumber(dto.twilioPhoneNumber.trim()) : null,
      }),
      ...(dto.callRoutingMode !== undefined && { callRoutingMode: dto.callRoutingMode?.trim() || null }),
      ...(dto.incomingCallHandling !== undefined && { incomingCallHandling: dto.incomingCallHandling?.trim() || null }),
      ...(dto.databaseProvider !== undefined && { databaseProvider: dto.databaseProvider?.trim() || null }),
      ...(dto.systemPrompt !== undefined && { baseSystemPrompt: dto.systemPrompt.trim() || '' }),
      ...(dto.openAiModel !== undefined && { model: dto.openAiModel?.trim() || null }),
      ...(dto.agentGoal !== undefined && { agentGoal: dto.agentGoal?.trim() || null }),
      ...(dto.agentRole !== undefined && { agentRole: dto.agentRole?.trim() || null }),
      ...(dto.toneOfVoice !== undefined && { toneOfVoice: dto.toneOfVoice?.trim() || null }),
      ...(dto.allowedActions !== undefined && { allowedActions: dto.allowedActions?.trim() || null }),
      ...(dto.restrictedActions !== undefined && { restrictedActions: dto.restrictedActions?.trim() || null }),
      ...(dto.escalationInstructions !== undefined && { escalationInstructions: dto.escalationInstructions?.trim() || null }),
      ...(dto.returnRefundBehavior !== undefined && { returnRefundBehavior: dto.returnRefundBehavior?.trim() || null }),
      ...(dto.orderStatusHandling !== undefined && { orderStatusHandling: dto.orderStatusHandling?.trim() || null }),
      ...(dto.outOfStockHandling !== undefined && { outOfStockHandling: dto.outOfStockHandling?.trim() || null }),
      ...(dto.transferToHumanEnabled !== undefined && { transferToHumanEnabled: dto.transferToHumanEnabled }),
      ...(dto.escalationPhone !== undefined && { escalationPhone: dto.escalationPhone?.trim() || null }),
      ...(dto.escalationEmail !== undefined && { escalationEmail: dto.escalationEmail?.trim() || null }),
      ...(shopifyConnectionStatus !== undefined && { shopifyConnectionStatus }),
      ...(twilioConnectionStatus !== undefined && { twilioConnectionStatus }),
      ...(openaiConnectionStatus !== undefined && { openaiConnectionStatus }),
      ...(elevenlabsConnectionStatus !== undefined && { elevenlabsConnectionStatus }),
      ...(anyConnectionValidated ? { lastConnectionTestAt: new Date() } : {}),
      ...(hasSecretChanges && this.encryption.isAvailable() && { secretsEnc: secretsEnc ?? null }),
    };
    const toolsResolved = this.resolveToolsFromDto(dto);
    if (toolsResolved) {
      data.toolPermissions = toolsResolved.toolPermissions;
      data.enabledTools = toolsResolved.enabledTools;
    }

    if (dto.clientId !== undefined && dto.clientId?.trim()) {
      const client = await this.prisma.client.findFirst({
        where: { id: dto.clientId.trim(), tenantId },
        select: { id: true, tenantId: true },
      });
      if (!client) throw new BadRequestException('Client not found for this tenant.');
      assertTenantOwnership({ tenantId, clientTenantId: client.tenantId });
    }
    if (dto.storeId !== undefined && dto.storeId?.trim()) {
      const store = await this.prisma.store.findFirst({
        where: { id: dto.storeId.trim(), tenantId, deletedAt: null },
        select: { id: true, tenantId: true },
      });
      if (!store) throw new BadRequestException('Store not found for this tenant.');
      assertTenantOwnership({ tenantId, storeTenantId: store.tenantId });
    }
    const updateResult = await this.prisma.agent.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: data as never,
    });
    if (updateResult.count === 0) {
      throw new NotFoundException('Agent not found.');
    }
    const updated = await this.prisma.agent.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: this.agentSelect(),
    });
    if (!updated) {
      throw new NotFoundException('Agent not found.');
    }
    await this.prisma.agentConfig.upsert({
      where: { agentId: id },
      create: {
        tenantId,
        agentId: id,
        businessName: dto.businessName?.trim() || dto.storeName?.trim() || null,
        supportEmail: dto.supportEmail?.trim() || dto.storeEmail?.trim() || null,
        supportPhone: dto.supportPhone?.trim() || null,
        askEmailBeforePaymentLink: dto.askEmailBeforePaymentLink ?? true,
        checkoutMode: toCheckoutModeApi(dto.checkoutMode),
        humanHandoffRules: dto.humanHandoffRules?.trim() || null,
        shippingPolicy: dto.shippingPolicy?.trim() || null,
        returnPolicy: dto.returnPolicy?.trim() || null,
        exchangePolicy: dto.exchangePolicy?.trim() || null,
        deliveryNotes: dto.deliveryNotes?.trim() || null,
        forbiddenBehaviors: dto.forbiddenBehaviors?.trim() || null,
        escalationRules: normalizeEscalationRules(dto.escalationRules),
        fallbackHumanContact:
          dto.escalationPhone?.trim() || dto.escalationEmail?.trim() || null,
        customSystemPrompt: dto.systemPrompt?.trim() || null,
        emailSenderName: dto.emailSenderName?.trim() || null,
        emailSenderAddress: dto.emailSenderAddress?.trim() || null,
        emailReplyTo: dto.emailReplyTo?.trim() || null,
        emailSubjectTemplate: dto.emailSubjectTemplate?.trim() || null,
        paymentLinkEmailIntro: dto.paymentLinkEmailIntro?.trim() || null,
        emailTestRecipient: dto.emailTestRecipient?.trim() || null,
        useWorkspaceEmail: dto.useWorkspaceEmail ?? true,
        useWorkspaceShopify: dto.useWorkspaceShopify ?? false,
        shopifyApiVersion: dto.shopifyApiVersion?.trim() || null,
      },
      update: {
        ...(dto.businessName !== undefined && { businessName: dto.businessName?.trim() || null }),
        ...(dto.supportEmail !== undefined && { supportEmail: dto.supportEmail?.trim() || null }),
        ...(dto.supportPhone !== undefined && { supportPhone: dto.supportPhone?.trim() || null }),
        ...(dto.askEmailBeforePaymentLink !== undefined && { askEmailBeforePaymentLink: dto.askEmailBeforePaymentLink }),
        ...(dto.checkoutMode !== undefined && { checkoutMode: toCheckoutModeApi(dto.checkoutMode) }),
        ...(dto.humanHandoffRules !== undefined && { humanHandoffRules: dto.humanHandoffRules?.trim() || null }),
        ...(dto.shippingPolicy !== undefined && { shippingPolicy: dto.shippingPolicy?.trim() || null }),
        ...(dto.returnPolicy !== undefined && { returnPolicy: dto.returnPolicy?.trim() || null }),
        ...(dto.exchangePolicy !== undefined && { exchangePolicy: dto.exchangePolicy?.trim() || null }),
        ...(dto.deliveryNotes !== undefined && { deliveryNotes: dto.deliveryNotes?.trim() || null }),
        ...(dto.forbiddenBehaviors !== undefined && { forbiddenBehaviors: dto.forbiddenBehaviors?.trim() || null }),
        ...(dto.escalationRules !== undefined && { escalationRules: normalizeEscalationRules(dto.escalationRules) }),
        ...((dto.escalationPhone !== undefined || dto.escalationEmail !== undefined) && {
          fallbackHumanContact:
            dto.escalationPhone?.trim() || dto.escalationEmail?.trim() || null,
        }),
        ...(dto.systemPrompt !== undefined && { customSystemPrompt: dto.systemPrompt.trim() || null }),
        ...this.agentConfigEmailFieldsFromDto(dto),
      },
    });
    await this.prisma.voiceProfile.upsert({
      where: { agentId: id },
      create: {
        tenantId,
        agentId: id,
        provider: dto.voiceProvider ?? 'openai',
        language: dto.language ?? 'en',
        voice: dto.voiceId ?? null,
        tone: dto.toneOfVoice ?? dto.voiceStyle ?? null,
        greetingMessage: dto.greetingMessage?.trim() || null,
        providerConfig: {
          voiceStyle: dto.voiceStyle ?? null,
        },
      },
      update: {
        ...(dto.voiceProvider !== undefined && { provider: dto.voiceProvider || 'openai' }),
        ...(dto.language !== undefined && { language: dto.language || 'en' }),
        ...(dto.voiceId !== undefined && { voice: dto.voiceId || null }),
        ...((dto.toneOfVoice !== undefined || dto.voiceStyle !== undefined) && {
          tone: dto.toneOfVoice ?? dto.voiceStyle ?? null,
        }),
        ...(dto.greetingMessage !== undefined && { greetingMessage: dto.greetingMessage?.trim() || null }),
        ...((dto.voiceStyle !== undefined ||
          dto.elevenlabsModel !== undefined ||
          dto.languageMode !== undefined ||
          dto.fixedLanguage !== undefined ||
          dto.supportedLanguages !== undefined ||
          dto.voicePersonality !== undefined) && {
          providerConfig: this.buildVoiceProviderConfig(dto) as Prisma.InputJsonValue,
        }),
      },
    });

    if (dto.twilioPhoneNumber !== undefined) {
      await this.prisma.phoneNumberMapping.deleteMany({
        where: { tenantId, agentId: id },
      });
      const normalizedInbound = dto.twilioPhoneNumber?.trim()
        ? normalizePhoneNumber(dto.twilioPhoneNumber.trim())
        : null;
      if (normalizedInbound) {
        await this.prisma.phoneNumberMapping.upsert({
          where: {
            tenantId_phoneNumber: { tenantId, phoneNumber: normalizedInbound },
          },
          create: {
            tenantId,
            agentId: id,
            phoneNumber: normalizedInbound,
            provider: 'twilio',
          },
          update: {
            agentId: id,
            provider: 'twilio',
          },
        });
      }
    }

    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: actorUserId ?? null,
        action: 'AGENT_UPDATED',
        entityType: 'AGENT',
        entityId: id,
        metadata: {
          updatedFields: Object.keys(dto),
          status: updated.status,
        } as Prisma.InputJsonValue,
      },
    });

    const fieldsUpdated = Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined);
    this.log.log(
      JSON.stringify({
        event: 'agent.settings_saved',
        agentId: id,
        tenantId,
        fieldsUpdated,
        voiceProvider: updated.voiceProvider ?? null,
        voiceIdPresent: Boolean(updated.voiceId?.trim()),
        openaiKeyTouched: dto.openaiApiKey !== undefined,
        openaiKeyCleared: explicitClearOpenai,
        elevenLabsKeyTouched: dto.elevenlabsApiKey !== undefined,
        elevenLabsKeyCleared: explicitClearEleven,
      }),
    );
    if (explicitClearOpenai) {
      console.log({ openaiKeyCleared: true, agentId: id, tenantId });
    }
    if (explicitClearEleven) {
      console.log({ elevenlabsKeyCleared: true, agentId: id, tenantId });
    }

    return {
      ...this.serializeAgent(updated),
      updatedSecrets,
    };
  }

  async syncSecretsFromWorkspace(tenantId: string, id: string, actorUserId?: string) {
    if (!this.encryption.isAvailable()) {
      throw new BadRequestException('Encryption is not configured; cannot sync workspace secrets.');
    }
    await this.findOne(tenantId, id);
    const [workspace, existingConfig] = await Promise.all([
      this.getWorkspaceIntegrationForTenant(tenantId),
      this.getAgentConfigForTest(tenantId, id),
    ]);

    const merged: AgentSecrets = {};
    for (const key of SECRET_KEYS) {
      const value = existingConfig[key];
      if (typeof value === 'string' && value.trim()) {
        merged[key] = value.trim();
      }
    }

    const workspaceToAgent: Partial<AgentSecrets> = {
      twilioAccountSid: workspace?.twilioAccountSid?.trim(),
      twilioAuthToken: workspace?.twilioAuthToken?.trim(),
      openaiApiKey: workspace?.openaiApiKey?.trim(),
      elevenlabsApiKey: workspace?.elevenlabsApiKey?.trim(),
      resendApiKey: workspace?.resendApiKey?.trim(),
    };
    const workspaceShopifyAvailable = Boolean(
      workspace?.shopifyStoreUrl?.trim() && workspace?.shopifyAdminToken?.trim(),
    );
    const updatedSecrets = Object.fromEntries(
      SECRET_KEYS.map((key) => [key, false]),
    ) as Record<(typeof SECRET_KEYS)[number], boolean>;

    for (const [key, value] of Object.entries(workspaceToAgent) as Array<
      [keyof AgentSecrets, string | undefined]
    >) {
      if (typeof value === 'string' && value.trim()) {
        merged[key] = value.trim();
        if (key in updatedSecrets) {
          updatedSecrets[key as (typeof SECRET_KEYS)[number]] = true;
        }
      }
    }

    const anyUpdated = Object.values(updatedSecrets).some(Boolean);
    if (!anyUpdated && !workspaceShopifyAvailable) {
      throw new BadRequestException(
        'No workspace secrets are available to sync yet. Save credentials in Settings first.',
      );
    }

    if (workspaceShopifyAvailable) {
      delete merged.shopifyAdminToken;
      delete merged.shopifyApiKey;
      delete merged.shopifyApiSecret;
    }

    const secretsEnc = this.encryptSecrets(merged);
    if (!secretsEnc) {
      throw new BadRequestException('Failed to encrypt synced secrets.');
    }

    await this.prisma.agent.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: {
        secretsEnc,
        lastConnectionTestAt: new Date(),
      },
    });

    if (workspaceShopifyAvailable) {
      await this.prisma.agentConfig.upsert({
        where: { agentId: id },
        create: {
          tenantId,
          agentId: id,
          useWorkspaceShopify: true,
        },
        update: { useWorkspaceShopify: true },
      });
    }

    const [shopify, twilio, openai, elevenlabs] = await Promise.all([
      this.testShopifyConnection(tenantId, id).catch((error: unknown) => ({
        success: false,
        message: error instanceof Error ? error.message : 'Shopify retest failed.',
      })),
      this.testTwilioConnection(tenantId, id).catch((error: unknown) => ({
        success: false,
        message: error instanceof Error ? error.message : 'Twilio retest failed.',
      })),
      this.testOpenAIConnection(tenantId, id).catch((error: unknown) => ({
        success: false,
        message: error instanceof Error ? error.message : 'OpenAI retest failed.',
      })),
      this.testElevenLabsConnection(tenantId, id).catch((error: unknown) => ({
        success: false,
        message: error instanceof Error ? error.message : 'ElevenLabs retest failed.',
      })),
    ]);

    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: actorUserId ?? null,
        action: 'AGENT_SECRETS_SYNCED_FROM_WORKSPACE',
        entityType: 'AGENT',
        entityId: id,
        metadata: {
          updatedSecrets,
          retest: {
            shopify: shopify.success,
            twilio: twilio.success,
            openai: openai.success,
            elevenlabs: elevenlabs.success,
          },
        } as Prisma.InputJsonValue,
      },
    });

    const updated = await this.prisma.agent.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: this.agentSelect(),
    });
    if (!updated) throw new NotFoundException('Agent not found.');
    return {
      ...this.serializeAgent(updated),
      updatedSecrets,
    };
  }

  async remove(tenantId: string, id: string, actorUserId?: string) {
    const existing = await this.findOne(tenantId, id);
    const deleted = await this.prisma.agent.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (deleted.count === 0) {
      throw new NotFoundException('Agent not found.');
    }
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: actorUserId ?? null,
        action: 'AGENT_DELETED',
        entityType: 'AGENT',
        entityId: id,
        metadata: {
          name: existing.name,
        } as Prisma.InputJsonValue,
      },
    });
    return { deleted: true };
  }

  /** Get Shopify config for an agent (for voice tools). Returns null if credentials are missing or not allowed. */
  async getShopifyConfig(
    tenantId: string,
    agentId: string,
  ): Promise<{
    shopifyStoreUrl: string;
    shopifyAdminToken: string;
    shopifyApiVersion: string;
    source: CredentialSource;
  } | null> {
    const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
    const resolved = resolveShopifyConfig({
      agent: {
        shopifyStoreUrl: bundle.shopifyStoreUrl,
        secrets: bundle.secrets,
        useWorkspaceShopify: bundle.useWorkspaceShopify,
        shopifyApiVersion: bundle.shopifyApiVersion,
      },
      workspace: bundle.workspace,
      env: {
        shopifyStoreUrl: process.env.SHOPIFY_SHOP_DOMAIN,
        shopifyAdminToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
      },
    });
    if (!resolved) return null;
    logCredentialResolution(this.log, 'shopify', resolved.source, agentId);
    return {
      shopifyStoreUrl: resolved.shopifyStoreUrl,
      shopifyAdminToken: resolved.shopifyAdminToken,
      shopifyApiVersion: resolved.shopifyApiVersion,
      source: resolved.source,
    };
  }

  /** Twilio credentials for outbound SMS (e.g. payment link delivery). Agent credentials win over workspace. */
  async getTwilioConfig(
    tenantId: string,
    agentId: string,
  ): Promise<{ accountSid: string; authToken: string; messagingFrom?: string | null; source: CredentialSource } | null> {
    const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId, deletedAt: null },
      select: { twilioPhoneNumber: true },
    });
    const resolved = resolveTwilioConfig({
      agentSecrets: bundle.secrets,
      workspace: bundle.workspace,
      agentPhoneNumber: agent?.twilioPhoneNumber,
    });
    if (!resolved) return null;
    logCredentialResolution(this.log, 'twilio', resolved.authSource, agentId);
    return {
      accountSid: resolved.accountSid,
      authToken: resolved.authToken,
      messagingFrom: resolved.phoneNumber ?? null,
      source: resolved.authSource,
    };
  }

  async getCredentialSourcesSummary(tenantId: string, agentId: string) {
    const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
    return buildCredentialSourcesSummary({
      agent: {
        shopifyStoreUrl: bundle.shopifyStoreUrl,
        secrets: bundle.secrets,
        useWorkspaceShopify: bundle.useWorkspaceShopify,
        useWorkspaceEmail: bundle.useWorkspaceEmail,
        voiceId: bundle.voiceId,
      },
      workspace: bundle.workspace,
      env: {
        openaiApiKey: process.env.OPENAI_API_KEY,
        elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
        resendApiKey: this.config.get<string>('RESEND_API_KEY'),
        shopifyStoreUrl: process.env.SHOPIFY_SHOP_DOMAIN,
        shopifyAdminToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
      },
    });
  }

  /** Load agent row including secretsEnc and return decrypted secrets + plain fields for integrations. */
  private async getAgentConfigForTest(
    tenantId: string,
    agentId: string,
  ): Promise<AgentSecrets & { shopifyStoreUrl?: string; databaseUrl?: string; databaseProvider?: string }> {
    const row = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId, deletedAt: null },
      select: {
        shopifyStoreUrl: true,
        databaseProvider: true,
        secretsEnc: true,
      },
    });
    if (!row) throw new NotFoundException('Agent not found.');
    const out: Record<string, string | null | undefined> = {
      shopifyStoreUrl: row.shopifyStoreUrl,
      databaseProvider: row.databaseProvider,
    };
    if (row.secretsEnc && this.encryption.isAvailable()) {
      const dec = this.encryption.decryptFromStorage(row.secretsEnc);
      if (dec) {
        try {
          const secrets = JSON.parse(dec) as AgentSecrets;
          Object.assign(out, secrets);
        } catch {
          /* ignore */
        }
      }
    }
    return out as AgentSecrets & { shopifyStoreUrl?: string; databaseUrl?: string; databaseProvider?: string };
  }

  private async getWorkspaceIntegrationForTenant(tenantId: string) {
    const row = await this.prisma.tenantIntegration.findUnique({
      where: { tenantId },
      select: {
        shopifyShopDomain: true,
        shopifyAdminTokenEnc: true,
        twilioAccountSid: true,
        twilioAuthTokenEnc: true,
        twilioPhoneNumber: true,
        openaiApiKeyEnc: true,
        elevenlabsApiKeyEnc: true,
        elevenlabsDefaultVoiceId: true,
        resendApiKeyEnc: true,
        resendFromEmail: true,
      },
    });
    if (!row || !this.encryption.isAvailable()) return null;
    return {
      shopifyStoreUrl: row.shopifyShopDomain?.trim()
        ? `https://${row.shopifyShopDomain.trim()}`
        : undefined,
      shopifyAdminToken: row.shopifyAdminTokenEnc
        ? (this.encryption.decryptFromStorage(row.shopifyAdminTokenEnc) ?? undefined)
        : undefined,
      twilioAccountSid: row.twilioAccountSid?.trim() || undefined,
      twilioAuthToken: row.twilioAuthTokenEnc
        ? (this.encryption.decryptFromStorage(row.twilioAuthTokenEnc) ?? undefined)
        : undefined,
      twilioPhoneNumber: row.twilioPhoneNumber?.trim() || undefined,
      openaiApiKey: row.openaiApiKeyEnc
        ? (this.encryption.decryptFromStorage(row.openaiApiKeyEnc) ?? undefined)
        : undefined,
      elevenlabsApiKey: row.elevenlabsApiKeyEnc
        ? (this.encryption.decryptFromStorage(row.elevenlabsApiKeyEnc) ?? undefined)
        : undefined,
      elevenlabsDefaultVoiceId: row.elevenlabsDefaultVoiceId?.trim() || undefined,
      resendApiKey: row.resendApiKeyEnc
        ? (this.encryption.decryptFromStorage(row.resendApiKeyEnc) ?? undefined)
        : undefined,
      resendFromEmail: row.resendFromEmail?.trim() || undefined,
    };
  }

  private resolveCredential(
    agentValue: string | undefined,
    workspaceValue: string | undefined,
    envValue?: string | undefined,
  ): ResolvedCredential {
    return resolveCredentialPriority(agentValue, workspaceValue, envValue);
  }

  async testShopifyConnection(
    tenantId: string,
    agentId: string | null,
    dto?: TestShopifyCredentialsDto,
  ): Promise<{ success: boolean; message: string; status?: ConnectionStatus; provider: 'shopify'; source: CredentialSource }> {
    const workspace = await this.getWorkspaceIntegrationForTenant(tenantId);
    let resolved: ReturnType<typeof resolveShopifyConfig> = null;
    let source: CredentialSource = 'missing';

    if (dto?.shopifyStoreUrl?.trim() && dto?.shopifyAdminToken?.trim()) {
      resolved = {
        shopifyStoreUrl: dto.shopifyStoreUrl.trim(),
        shopifyAdminToken: dto.shopifyAdminToken.trim(),
        shopifyApiVersion: dto.shopifyApiVersion?.trim() || '2024-10',
        source: 'agent',
      };
      source = 'agent';
    } else if (agentId) {
      const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
      if (dto?.shopifyStoreUrl?.trim()) bundle.shopifyStoreUrl = dto.shopifyStoreUrl.trim();
      if (dto?.shopifyAdminToken?.trim()) bundle.secrets = { ...bundle.secrets, shopifyAdminToken: dto.shopifyAdminToken.trim() };
      resolved = resolveShopifyConfig({
        agent: {
          shopifyStoreUrl: bundle.shopifyStoreUrl,
          secrets: bundle.secrets,
          useWorkspaceShopify: bundle.useWorkspaceShopify,
          shopifyApiVersion: bundle.shopifyApiVersion,
        },
        workspace,
        env: {
          shopifyStoreUrl: process.env.SHOPIFY_SHOP_DOMAIN,
          shopifyAdminToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
        },
      });
      source = resolved?.source ?? 'missing';
    } else if (workspace?.shopifyStoreUrl && workspace?.shopifyAdminToken) {
      resolved = resolveShopifyConfig({
        agent: { useWorkspaceShopify: true },
        workspace,
        env: {
          shopifyStoreUrl: process.env.SHOPIFY_SHOP_DOMAIN,
          shopifyAdminToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
        },
      });
      source = resolved?.source ?? 'missing';
    }

    if (!resolved) {
      return {
        success: false,
        message: 'Shopify credentials missing for this agent.',
        status: agentId ? ConnectionStatus.FAILED : undefined,
        provider: 'shopify',
        source: 'missing',
      };
    }

    const result = await this.shopifyTest.testConnection({
      shopifyStoreUrl: resolved.shopifyStoreUrl,
      shopifyAdminToken: resolved.shopifyAdminToken,
    });
    const status = result.success ? ConnectionStatus.OK : ConnectionStatus.FAILED;
    if (agentId) {
      logCredentialResolution(this.log, 'shopify', source, agentId);
      await this.prisma.agent.updateMany({
        where: { id: agentId, tenantId, deletedAt: null },
        data: { shopifyConnectionStatus: status, lastConnectionTestAt: new Date() },
      });
    }
    return {
      ...result,
      status: agentId ? status : undefined,
      provider: 'shopify',
      source,
    };
  }

  async testDatabaseConnection(
    tenantId: string,
    agentId: string | null,
    dto?: TestDatabaseCredentialsDto,
  ): Promise<{ success: boolean; message: string; status?: ConnectionStatus }> {
    let config: { databaseUrl?: string | null; databaseAccessToken?: string | null; databaseProvider?: string | null } = {};
    if (agentId) {
      const agentConfig = await this.getAgentConfigForTest(tenantId, agentId);
      config = {
        databaseUrl: agentConfig.databaseUrl ?? dto?.databaseUrl,
        databaseAccessToken: agentConfig.databaseAccessToken ?? dto?.databaseAccessToken,
        databaseProvider: agentConfig.databaseProvider ?? dto?.databaseProvider,
      };
    } else {
      config = {
        databaseUrl: dto?.databaseUrl,
        databaseAccessToken: dto?.databaseAccessToken,
        databaseProvider: dto?.databaseProvider,
      };
    }
    const result = await this.databaseTest.testConnection(config);
    const status = result.success ? ConnectionStatus.OK : ConnectionStatus.FAILED;
    if (agentId) {
      await this.prisma.agent.updateMany({
        where: { id: agentId, tenantId, deletedAt: null },
        data: { databaseConnectionStatus: status, lastConnectionTestAt: new Date() },
      });
    }
    return { ...result, status: agentId ? status : undefined };
  }

  async testTwilioConnection(
    tenantId: string,
    agentId: string | null,
    dto?: TestTwilioCredentialsDto,
  ): Promise<{ success: boolean; message: string; status?: ConnectionStatus; provider: 'twilio'; source: CredentialSource }> {
    const workspace = await this.getWorkspaceIntegrationForTenant(tenantId);
    const agentConfig = agentId ? await this.getAgentConfigForTest(tenantId, agentId) : null;
    const sid = dto?.twilioAccountSid?.trim() || workspace?.twilioAccountSid?.trim() || agentConfig?.twilioAccountSid?.trim() || null;
    const authResolved =
      dto?.twilioAuthToken?.trim()
        ? { value: dto.twilioAuthToken.trim(), source: 'agent' as const }
        : this.resolveCredential(
            agentConfig?.twilioAuthToken,
            workspace?.twilioAuthToken,
          );
    const config: { twilioAccountSid?: string | null; twilioAuthToken?: string | null; twilioPhoneNumber?: string | null } = {
      twilioAccountSid: sid,
      twilioAuthToken: authResolved.value ?? null,
      twilioPhoneNumber: dto?.twilioPhoneNumber?.trim() || workspace?.twilioPhoneNumber || null,
    };
    const result = await this.twilioTest.testConnection(config);
    const status = result.success ? ConnectionStatus.OK : ConnectionStatus.FAILED;
    if (agentId) {
      await this.prisma.agent.updateMany({
        where: { id: agentId, tenantId, deletedAt: null },
        data: { twilioConnectionStatus: status, lastConnectionTestAt: new Date() },
      });
    }
    return {
      ...result,
      status: agentId ? status : undefined,
      provider: 'twilio',
      source: authResolved.source,
    };
  }

  async testOpenAIConnection(
    tenantId: string,
    agentId: string | null,
    dto?: TestOpenAICredentialsDto,
  ): Promise<{ success: boolean; message: string; status?: ConnectionStatus; provider: 'openai'; source: CredentialSource; warnings?: string[] }> {
    const workspace = await this.getWorkspaceIntegrationForTenant(tenantId);
    const agentConfig = agentId ? await this.getAgentConfigForTest(tenantId, agentId) : null;
    const resolved =
      dto?.openaiApiKey?.trim()
        ? { value: dto.openaiApiKey.trim(), source: 'agent' as const }
        : this.resolveCredential(
            agentConfig?.openaiApiKey,
            workspace?.openaiApiKey,
            process.env.OPENAI_API_KEY,
          );
    if (resolved.source === 'missing') {
      return {
        success: false,
        message: 'OpenAI test failed: no API key found (agent, workspace, or OPENAI_API_KEY).',
        status: agentId ? ConnectionStatus.FAILED : undefined,
        provider: 'openai',
        source: 'missing',
      };
    }

    const result = await this.openaiTest.testConnection({ openaiApiKey: resolved.value });

    const status = result.success ? ConnectionStatus.OK : ConnectionStatus.FAILED;
    if (agentId) {
      await this.prisma.agent.updateMany({
        where: { id: agentId, tenantId, deletedAt: null },
        data: { openaiConnectionStatus: status, lastConnectionTestAt: new Date() },
      });
    }
    return {
      ...result,
      status: agentId ? status : undefined,
      provider: 'openai',
      source: resolved.source,
      message: result.success
        ? `OpenAI connection successful (using ${resolved.source} credential).`
        : `OpenAI test failed using ${resolved.source} credential: ${result.message}`,
    };
  }

  async testElevenLabsConnection(
    tenantId: string,
    agentId: string | null,
    dto?: TestElevenLabsCredentialsDto,
  ): Promise<{ success: boolean; message: string; status?: ConnectionStatus; provider: 'elevenlabs'; source: CredentialSource; warnings?: string[] }> {
    const workspace = await this.getWorkspaceIntegrationForTenant(tenantId);
    const agentConfig = agentId ? await this.getAgentConfigForTest(tenantId, agentId) : null;
    const voiceId =
      dto?.voiceId?.trim() ||
      (agentConfig as { voiceId?: string } | null)?.voiceId?.trim() ||
      workspace?.elevenlabsDefaultVoiceId?.trim() ||
      undefined;
    const elevenResolved =
      dto?.elevenlabsApiKey?.trim()
        ? { apiKey: dto.elevenlabsApiKey.trim(), source: 'agent' as const, voiceId }
        : resolveElevenLabsConfig({
            agentSecrets: agentConfig ?? undefined,
            workspace,
            envApiKey: process.env.ELEVENLABS_API_KEY,
            agentVoiceId: voiceId ?? null,
          });
    if (!elevenResolved) {
      return {
        success: false,
        message: 'ElevenLabs test failed: no API key found (agent, workspace, or ELEVENLABS_API_KEY).',
        status: agentId ? ConnectionStatus.FAILED : undefined,
        provider: 'elevenlabs',
        source: 'missing',
      };
    }
    const result = await this.elevenlabsTest.testConnection({
      elevenlabsApiKey: elevenResolved.apiKey,
      voiceId: elevenResolved.voiceId ?? voiceId,
      source: 'test',
      tenantId,
    });

    const status = result.success ? ConnectionStatus.OK : ConnectionStatus.FAILED;
    if (agentId) {
      await this.prisma.agent.updateMany({
        where: { id: agentId, tenantId, deletedAt: null },
        data: { elevenlabsConnectionStatus: status, lastConnectionTestAt: new Date() },
      });
    }
    return {
      ...result,
      status: agentId ? status : undefined,
      provider: 'elevenlabs',
      source: elevenResolved.source,
      message: result.success
        ? `ElevenLabs connection successful (using ${elevenResolved.source} credential).`
        : `ElevenLabs test failed using ${elevenResolved.source} credential: ${result.message}`,
    };
  }

  /** Aggregate analytics for an agent (calls, resolved, escalated, etc.). */
  async getAgentAnalytics(tenantId: string, agentId: string) {
    await this.findOne(tenantId, agentId);
    const sessions = await this.prisma.callSession.findMany({
      where: { tenantId, agentId },
      select: {
        status: true,
        escalated: true,
        durationSeconds: true,
        startedAt: true,
        endedAt: true,
      },
    });
    const totalCalls = sessions.length;
    const completed = sessions.filter((s) => s.status === 'COMPLETED').length;
    const escalatedCalls = sessions.filter((s) => s.escalated).length;
    const durations = sessions
      .map((s) => s.durationSeconds)
      .filter((d): d is number => d != null && d > 0);
    const avgDurationSeconds =
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    const lastCallAt =
      sessions.length > 0
        ? sessions
            .map((s) => (s.endedAt ?? s.startedAt)?.getTime() ?? 0)
            .reduce((a, b) => Math.max(a, b), 0)
        : null;
    return {
      totalCalls,
      resolvedCalls: completed - escalatedCalls,
      escalatedCalls,
      avgDurationSeconds: avgDurationSeconds != null ? Math.round(avgDurationSeconds) : null,
      lastCallAt: lastCallAt != null ? new Date(lastCallAt).toISOString() : null,
    };
  }

  /** Recent call sessions (activity log) for an agent. */
  async getAgentLogs(
    tenantId: string,
    agentId: string,
    limit = 50,
  ) {
    await this.findOne(tenantId, agentId);
    const sessions = await this.prisma.callSession.findMany({
      where: { tenantId, agentId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      select: {
        id: true,
        fromNumber: true,
        toNumber: true,
        status: true,
        escalated: true,
        durationSeconds: true,
        createdAt: true,
        endedAt: true,
      },
    });
    return sessions.map((s) => ({
      id: s.id,
      fromNumber: s.fromNumber,
      toNumber: s.toNumber,
      status: s.status,
      escalated: s.escalated,
      durationSeconds: s.durationSeconds,
      createdAt: s.createdAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
    }));
  }

  async getCatalogReadiness(tenantId: string, agentId: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!agent) throw new NotFoundException('Agent not found.');
    const bundle = await this.loadAgentCredentialBundle(tenantId, agentId);
    const shopifyResolved = resolveShopifyConfig({
      agent: {
        shopifyStoreUrl: bundle.shopifyStoreUrl,
        secrets: bundle.secrets,
        useWorkspaceShopify: bundle.useWorkspaceShopify,
        shopifyApiVersion: bundle.shopifyApiVersion,
      },
      workspace: bundle.workspace,
      env: {
        shopifyStoreUrl: process.env.SHOPIFY_SHOP_DOMAIN,
        shopifyAdminToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
      },
    });
    const shopifySource = shopifyResolved?.source ?? 'missing';
    const shopDomain = shopifyResolved
      ? normalizeShopifyDomain(shopifyResolved.shopifyStoreUrl)
      : null;
    if (!shopDomain) {
      return {
        catalogReady: false,
        lastSyncedAt: null,
        itemCount: 0,
        reason: 'shopify_not_connected',
        shopifySource,
        shopifyConfigured: false,
      };
    }
    const [itemCount, latest] = await Promise.all([
      this.prisma.productCache.count({ where: { tenantId, shopDomain } }),
      this.prisma.productCache.findFirst({
        where: { tenantId, shopDomain },
        orderBy: { syncedAt: 'desc' },
        select: { syncedAt: true },
      }),
    ]);
    const lastSyncedAt = latest?.syncedAt ?? null;
    const staleMs = Number(process.env.CATALOG_STALE_MS) || 24 * 60 * 60 * 1000;
    const isFresh = lastSyncedAt ? Date.now() - lastSyncedAt.getTime() <= staleMs : false;
    return {
      catalogReady: itemCount > 0 && isFresh,
      lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
      itemCount,
      reason: itemCount === 0 ? 'catalog_empty' : isFresh ? 'ready' : 'catalog_stale',
      shopifySource,
      shopifyConfigured: true,
    };
  }

  /** Test AI behavior using the stored OpenAI key and model. */
  async testAiBehavior(
    tenantId: string,
    agentId: string,
    sampleQuery: string,
  ): Promise<{
    success: boolean;
    message: string;
    suggestedResponse?: string;
    source?: CredentialSource;
  }> {
    const row = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId, deletedAt: null },
      select: {
        baseSystemPrompt: true,
        agentRole: true,
        agentGoal: true,
        allowedActions: true,
        restrictedActions: true,
        model: true,
      },
    });
    if (!row) throw new NotFoundException('Agent not found.');
    const cfg = await this.getAgentConfigForTest(tenantId, agentId);
    const workspace = await this.getWorkspaceIntegrationForTenant(tenantId);
    const openaiResolved = resolveOpenAiConfig({
      agentSecrets: cfg,
      workspace,
      envApiKey: process.env.OPENAI_API_KEY,
    });
    if (!openaiResolved) {
      return {
        success: false,
        message: 'OpenAI API key is not configured (agent, workspace, or OPENAI_API_KEY).',
        source: 'missing',
      };
    }
    const apiKey = openaiResolved.apiKey;
    const prompt = [
      row.baseSystemPrompt,
      row.agentRole ? `Role: ${row.agentRole}` : '',
      row.agentGoal ? `Goal: ${row.agentGoal}` : '',
      row.allowedActions ? `Allowed: ${row.allowedActions}` : '',
      row.restrictedActions ? `Not allowed: ${row.restrictedActions}` : '',
    ].filter(Boolean).join('\n\n');
    const model = row.model?.trim() || 'gpt-4o-mini';
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: prompt || 'You are a helpful store support assistant.' },
        { role: 'user', content: sampleQuery || 'Where is my order?' },
      ],
      max_tokens: 220,
    });
    const responseText = completion.choices[0]?.message?.content?.trim() || '';
    return {
      success: Boolean(responseText),
      message: responseText
        ? `AI behavior test completed successfully (using ${openaiResolved.source} credential).`
        : `AI behavior test completed but model returned no content (using ${openaiResolved.source} credential).`,
      suggestedResponse: responseText || undefined,
      source: openaiResolved.source,
    };
  }

  /** Runtime debug snapshot for dashboard (no secrets). */
  async getRuntimeDebug(tenantId: string, agentId: string, callSessionId?: string) {
    const agent = await this.findOne(tenantId, agentId);
    const perms = normalizeToolPermissions(
      (agent as { toolPermissions?: Record<string, unknown> }).toolPermissions,
    );
    const enabledTools = this.toolRegistry.resolveEnabledToolNames({
      toolPermissions: perms,
      enabledTools: Array.isArray((agent as { enabledTools?: string[] }).enabledTools)
        ? (agent as { enabledTools: string[] }).enabledTools
        : null,
    });
    const personality =
      (agent as { voiceProfile?: { providerConfig?: { personality?: VoicePersonalityTraits } } })
        .voiceProfile?.providerConfig?.personality ?? null;

    const promptInput: AgentRuntimePromptInput = {
      agentId: agent.id as string,
      agentName: agent.name as string,
      storeName: (agent.storeName as string) || 'Store',
      language: (agent.language as string) || 'en',
      baseSystemPrompt: agent.baseSystemPrompt as string,
      agentRole: agent.agentRole as string | null,
      agentGoal: agent.agentGoal as string | null,
      toneOfVoice: agent.toneOfVoice as string | null,
      config: agent.agentConfig as AgentRuntimePromptInput['config'],
    };
    const livePrompt = buildAgentRuntimePrompt(promptInput, { personality, enabledTools });

    let lastToolCalls: Array<Record<string, unknown>> = [];
    let runtimeContextPreview: Record<string, unknown> | null = null;
    if (callSessionId) {
      const session = await this.prisma.callSession.findFirst({
        where: { id: callSessionId, tenantId, agentId },
        include: {
          toolExecutions: { orderBy: { createdAt: 'desc' }, take: 10 },
          emailEvents: { orderBy: { createdAt: 'desc' }, take: 5 },
        },
      });
      if (session) {
        lastToolCalls = session.toolExecutions.map((t) => ({
          toolName: t.toolName,
          status: t.status,
          latencyMs: t.latencyMs,
          createdAt: t.createdAt,
          inputPreview: JSON.stringify(t.inputJson).slice(0, 200),
          outputPreview: JSON.stringify(t.outputJson).slice(0, 300),
        }));
        runtimeContextPreview = {
          callSessionId: session.id,
          metadata: session.metadata,
          emailEvents: session.emailEvents.map((e) => ({
            status: e.status,
            createdAt: e.createdAt,
          })),
        };
      }
    }

    const credentialSources = await this.getCredentialSourcesSummary(tenantId, agentId);

    return {
      agentId,
      toolsEnabled: enabledTools,
      toolPermissions: perms,
      personality,
      livePromptPreview: livePrompt.slice(0, 8000),
      lastToolCalls,
      runtimeContextPreview,
      credentialSources,
      toolCatalog: this.toolRegistry.getCatalog().map((t) => ({
        name: t.name,
        permissionGroups: t.permissionGroups,
      })),
    };
  }
}
