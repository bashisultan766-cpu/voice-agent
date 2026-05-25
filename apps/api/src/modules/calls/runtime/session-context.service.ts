import { Injectable, Logger } from '@nestjs/common';
import type { VoiceAgentRuntimeConfig } from '@bookstore-voice-agents/types';
import { normalizeShopifyDomain } from '@bookstore-voice-agents/types';
import { PrismaService } from '../../../database/prisma.service';
import { EncryptionService } from '../../../common/encryption.service';
import {
  openAiKeyLayerPresence,
  resolveElevenLabsKeyChain,
  resolveOpenAiKeyChain,
  type VoiceCredentialSource,
} from './voice-config-resolution.util';
import {
  buildCredentialSourcesSummary,
  resolveShopifyConfig,
  type AgentSecretsSlice,
  type CredentialSource,
} from '../../../common/credential-resolver.util';

export interface VoiceSessionContext {
  callSessionId: string;
  tenantId: string;
  storeId: string | null;
  agentId: string;
  phoneNumberId?: string | null;
  fromNumber?: string | null;
  toNumber?: string | null;
  agent: {
    name: string;
    voice?: string | null;
    voiceProvider?: string | null;
    voiceId?: string | null;
    voiceStyle?: string | null;
    language: string;
    baseSystemPrompt: string;
    agentGoal?: string | null;
    agentRole?: string | null;
    toneOfVoice?: string | null;
    allowedActions?: string | null;
    restrictedActions?: string | null;
    escalationInstructions?: string | null;
    returnRefundBehavior?: string | null;
    orderStatusHandling?: string | null;
    outOfStockHandling?: string | null;
    transferToHumanEnabled?: boolean | null;
    escalationPhone?: string | null;
    escalationEmail?: string | null;
    greetingMessage?: string | null;
    fallbackMessage?: string | null;
    escalationMessage?: string | null;
    model?: string | null;
    temperature?: number | null;
    enabledTools?: string[] | null;
    toolPermissions?: Record<string, unknown> | null;
    personality?: Record<string, unknown> | null;
    maxToolCallsPerTurn?: number | null;
    handoffEnabled?: boolean | null;
    knowledgeBaseSource?: string | null;
    knowledgeSyncEnabled?: boolean | null;
    callRoutingMode?: string | null;
    incomingCallHandling?: string | null;
    openaiApiKey?: string | null;
    elevenlabsApiKey?: string | null;
    elevenlabsModel?: string | null;
    languageMode?: 'auto' | 'fixed' | null;
    fixedLanguage?: string | null;
    supportedLanguages?: string[] | null;
    config?: VoiceAgentRuntimeConfig | null;
    shopify?: {
      storeUrl?: string | null;
      /** Normalized myshopify.com-style domain; matches ProductCache.shopDomain when sync has run. */
      shopDomain?: string | null;
      shopifyConnectionId?: string | null;
      hasAdminToken?: boolean;
      connectionStatus?: string | null;
    } | null;
    /** Filled each load from DB — no global cache of decrypted secrets. */
    runtimeCredentialHints?: {
      openaiKeySource: VoiceCredentialSource;
      elevenLabsKeySource: VoiceCredentialSource;
      shopifySource: CredentialSource;
      shopifyConfigured: boolean;
      resendSource: CredentialSource;
      twilioSource: CredentialSource;
    };
  };
  /** Agent row `updatedAt` when context was built (fresh read). */
  configUpdatedAt?: string | null;
  store: {
    name: string;
    city?: string | null;
    timezone?: string | null;
  };
  metadata?: Record<string, unknown>;
}

@Injectable()
export class SessionContextService {
  private readonly log = new Logger(SessionContextService.name);

  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService) {}

  async load(callSessionId: string): Promise<VoiceSessionContext | null> {
    const session = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      include: {
        agent: { include: { agentConfig: true, voiceProfile: true } },
        store: {
          include: {
            shopifyConnection: { select: { id: true, shopDomain: true, accessTokenEnc: true } },
          },
        },
      },
    });
    if (!session) return null;
    const store = session.store;
    const storeName = store?.name ?? session.agent.storeName ?? 'Store';
    const storeCity = store?.city ?? null;
    const storeTimezone = store?.timezone ?? session.agent.timezone ?? null;

    let agentOpenaiPlain: string | null = null;
    let agentElevenPlain: string | null = null;
    let agentSecrets: AgentSecretsSlice = {};
    let useWorkspaceShopify = false;
    let shopifyApiVersion: string | null = null;
    let workspaceElevenlabsDefaultVoiceId: string | null = null;
    let workspaceElevenlabsDefaultModel: string | null = null;
    let tiOpenaiEnc: string | null = null;
    let tiElevenEnc: string | null = null;

    if (session.agent.secretsEnc && this.encryption.isAvailable()) {
      const dec = this.encryption.decryptFromStorage(session.agent.secretsEnc);
      if (dec) {
        try {
          const secrets = JSON.parse(dec) as AgentSecretsSlice & {
            openaiApiKey?: string;
            elevenlabsApiKey?: string;
          };
          agentSecrets = secrets;
          agentOpenaiPlain = typeof secrets.openaiApiKey === 'string' ? secrets.openaiApiKey : null;
          agentElevenPlain = typeof secrets.elevenlabsApiKey === 'string' ? secrets.elevenlabsApiKey : null;
        } catch {
          /* ignore - keep keys null */
        }
      }
    }

    useWorkspaceShopify = session.agent.agentConfig?.useWorkspaceShopify === true;
    shopifyApiVersion = session.agent.agentConfig?.shopifyApiVersion ?? null;

    let workspaceShopify: { shopifyStoreUrl?: string; shopifyAdminToken?: string } | null = null;
    if (this.encryption.isAvailable()) {
      const ti = await this.prisma.tenantIntegration.findUnique({
        where: { tenantId: session.tenantId },
        select: {
          openaiApiKeyEnc: true,
          elevenlabsApiKeyEnc: true,
          elevenlabsDefaultModel: true,
          elevenlabsDefaultVoiceId: true,
          shopifyShopDomain: true,
          shopifyAdminTokenEnc: true,
        },
      });
      workspaceElevenlabsDefaultVoiceId = ti?.elevenlabsDefaultVoiceId?.trim() || null;
      workspaceElevenlabsDefaultModel = ti?.elevenlabsDefaultModel?.trim() || null;
      tiOpenaiEnc = ti?.openaiApiKeyEnc ?? null;
      tiElevenEnc = ti?.elevenlabsApiKeyEnc ?? null;
      if (ti?.shopifyShopDomain?.trim()) {
        const host = ti.shopifyShopDomain.trim();
        workspaceShopify = {
          shopifyStoreUrl: host.startsWith('http') ? host : `https://${host}`,
          shopifyAdminToken: ti.shopifyAdminTokenEnc
            ? (this.encryption.decryptFromStorage(ti.shopifyAdminTokenEnc) ?? undefined)
            : undefined,
        };
      }
    }

    const shopifyResolved = resolveShopifyConfig({
      agent: {
        shopifyStoreUrl: session.agent.shopifyStoreUrl,
        secrets: agentSecrets,
        useWorkspaceShopify,
        shopifyApiVersion,
      },
      workspace: workspaceShopify,
      env: {
        shopifyStoreUrl: process.env.SHOPIFY_SHOP_DOMAIN,
        shopifyAdminToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
      },
    });
    const shopifyAdminToken = shopifyResolved?.shopifyAdminToken ?? null;
    const credentialSources = buildCredentialSourcesSummary({
      agent: {
        shopifyStoreUrl: session.agent.shopifyStoreUrl,
        secrets: agentSecrets,
        useWorkspaceShopify,
        useWorkspaceEmail: session.agent.agentConfig?.useWorkspaceEmail !== false,
        voiceId: session.agent.voiceId,
      },
      workspace: workspaceShopify ?? undefined,
      env: {
        openaiApiKey: process.env.OPENAI_API_KEY,
        elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
      },
    });

    const encAvail = this.encryption.isAvailable();
    const openaiResolved = resolveOpenAiKeyChain({
      agentSecretPlain: agentOpenaiPlain,
      tenantEnc: tiOpenaiEnc,
      decryptFromStorage: (s) => this.encryption.decryptFromStorage(s),
      envPlain: process.env.OPENAI_API_KEY,
      encryptionAvailable: encAvail,
    });
    const openaiLayers = openAiKeyLayerPresence({
      agentSecretPlain: agentOpenaiPlain,
      tenantEnc: tiOpenaiEnc,
      envPlain: process.env.OPENAI_API_KEY,
    });
    const openaiKeySource = openaiResolved.source;
    console.log({
      openaiKeySource,
      agentKeyPresent: openaiLayers.agentKeyPresent,
      tenantKeyPresent: openaiLayers.tenantKeyPresent,
      envKeyPresent: openaiLayers.envKeyPresent,
      callSessionId: session.id,
      agentId: session.agentId,
      tenantId: session.tenantId,
    });
    const elevenResolved = resolveElevenLabsKeyChain({
      agentSecretPlain: agentElevenPlain,
      tenantEnc: tiElevenEnc,
      decryptFromStorage: (s) => this.encryption.decryptFromStorage(s),
      envPlain: process.env.ELEVENLABS_API_KEY,
      encryptionAvailable: encAvail,
    });

    const openaiApiKey = openaiResolved.value;
    const elevenlabsApiKey = elevenResolved.value;

    const shopDomain =
      normalizeShopifyDomain(shopifyResolved?.shopifyStoreUrl ?? session.agent.shopifyStoreUrl) ||
      normalizeShopifyDomain(store?.shopifyConnection?.shopDomain ? `https://${store.shopifyConnection.shopDomain}` : null);

    const configUpdatedAt = session.agent.updatedAt?.toISOString() ?? null;
    const voiceIdEffective = session.agent.voiceId ?? workspaceElevenlabsDefaultVoiceId;
    this.log.log(
      JSON.stringify({
        event: 'voice.session_context.loaded_fresh',
        message: 'Loaded fresh agent config for call',
        callSessionId: session.id,
        agentId: session.agentId,
        tenantId: session.tenantId,
        model: session.agent.model ?? null,
        voiceProvider: session.agent.voiceProvider ?? null,
        voiceIdPresent: Boolean(voiceIdEffective?.trim()),
        openaiKeySource,
        elevenLabsKeySource: elevenResolved.source,
        openaiKeyPresent: Boolean(openaiApiKey?.trim()),
        elevenLabsKeyPresent: Boolean(elevenlabsApiKey?.trim()),
        configUpdatedAt,
        fieldsUpdated: null,
        /** If both agent and tenant carry OpenAI keys, agent wins; log helps debug “Settings ignored” reports. */
        precedenceNote:
          openaiKeySource === 'agent' && tiOpenaiEnc
            ? 'active_openai_from_agent_secrets_tenant_key_present_but_not_used'
            : null,
      }),
    );

    return {
      callSessionId: session.id,
      tenantId: session.tenantId,
      storeId: session.storeId,
      agentId: session.agentId,
      phoneNumberId: session.phoneNumberId,
      fromNumber: session.fromNumber,
      toNumber: session.toNumber,
      configUpdatedAt,
      agent: {
        name: session.agent.name,
        voice: session.agent.voice,
        voiceProvider: session.agent.voiceProvider,
        voiceId: session.agent.voiceId ?? workspaceElevenlabsDefaultVoiceId,
        voiceStyle: session.agent.voiceStyle,
        language: session.agent.language,
        baseSystemPrompt: session.agent.baseSystemPrompt,
        agentGoal: session.agent.agentGoal ?? null,
        agentRole: session.agent.agentRole ?? null,
        toneOfVoice: session.agent.toneOfVoice ?? null,
        allowedActions: session.agent.allowedActions ?? null,
        restrictedActions: session.agent.restrictedActions ?? null,
        escalationInstructions: session.agent.escalationInstructions ?? null,
        returnRefundBehavior: session.agent.returnRefundBehavior ?? null,
        orderStatusHandling: session.agent.orderStatusHandling ?? null,
        outOfStockHandling: session.agent.outOfStockHandling ?? null,
        transferToHumanEnabled: session.agent.transferToHumanEnabled ?? true,
        escalationPhone: session.agent.escalationPhone ?? null,
        escalationEmail: session.agent.escalationEmail ?? null,
        greetingMessage: session.agent.greetingMessage,
        fallbackMessage: session.agent.fallbackMessage,
        escalationMessage: session.agent.escalationMessage,
        model: session.agent.model,
        temperature: session.agent.temperature,
        enabledTools: Array.isArray(session.agent.enabledTools) ? (session.agent.enabledTools as string[]) : null,
        toolPermissions:
          session.agent.toolPermissions && typeof session.agent.toolPermissions === 'object'
            ? (session.agent.toolPermissions as Record<string, unknown>)
            : null,
        personality:
          (session.agent.voiceProfile?.providerConfig as { personality?: Record<string, unknown> } | null)
            ?.personality ?? null,
        maxToolCallsPerTurn: session.agent.maxToolCallsPerTurn ?? null,
        handoffEnabled: session.agent.handoffEnabled ?? null,
        knowledgeBaseSource: session.agent.knowledgeBaseSource ?? null,
        knowledgeSyncEnabled: session.agent.knowledgeSyncEnabled ?? null,
        callRoutingMode: session.agent.callRoutingMode ?? null,
        incomingCallHandling: session.agent.incomingCallHandling ?? null,
        openaiApiKey,
        elevenlabsApiKey,
        elevenlabsModel:
          (session.agent.voiceProfile?.providerConfig as { elevenlabsModel?: string } | null)?.elevenlabsModel ??
          workspaceElevenlabsDefaultModel ??
          null,
        languageMode:
          (session.agent.voiceProfile?.providerConfig as { languageMode?: 'auto' | 'fixed' } | null)?.languageMode ??
          'auto',
        fixedLanguage:
          (session.agent.voiceProfile?.providerConfig as { fixedLanguage?: string } | null)?.fixedLanguage ??
          null,
        supportedLanguages:
          (session.agent.voiceProfile?.providerConfig as { supportedLanguages?: string[] } | null)?.supportedLanguages ??
          ['en', 'ur', 'hi', 'ar', 'es', 'fr', 'de'],
        config: session.agent.agentConfig
          ? ({
              businessName: session.agent.agentConfig.businessName,
              supportEmail: session.agent.agentConfig.supportEmail,
              supportPhone: session.agent.agentConfig.supportPhone,
              shippingPolicy: session.agent.agentConfig.shippingPolicy,
              returnPolicy: session.agent.agentConfig.returnPolicy,
              exchangePolicy: session.agent.agentConfig.exchangePolicy,
              deliveryNotes: session.agent.agentConfig.deliveryNotes,
              escalationRules: session.agent.agentConfig.escalationRules,
              forbiddenBehaviors: session.agent.agentConfig.forbiddenBehaviors,
              checkoutMode: session.agent.agentConfig.checkoutMode,
              askEmailBeforePaymentLink: session.agent.agentConfig.askEmailBeforePaymentLink,
              fallbackHumanContact: session.agent.agentConfig.fallbackHumanContact,
              customSystemPrompt: session.agent.agentConfig.customSystemPrompt,
              humanHandoffRules: session.agent.agentConfig.humanHandoffRules,
            } satisfies VoiceAgentRuntimeConfig)
          : null,
        shopify: {
          storeUrl: session.agent.shopifyStoreUrl ?? null,
          shopDomain,
          shopifyConnectionId: store?.shopifyConnection?.id ?? null,
          hasAdminToken: Boolean(shopifyAdminToken?.trim()),
          connectionStatus: session.agent.shopifyConnectionStatus ?? null,
        },
        runtimeCredentialHints: {
          openaiKeySource,
          elevenLabsKeySource: elevenResolved.source,
          shopifySource: credentialSources.shopify.source,
          shopifyConfigured: credentialSources.shopify.configured,
          resendSource: credentialSources.resend.source,
          twilioSource: credentialSources.twilio.authSource,
        },
      },
      store: {
        name: storeName,
        city: storeCity,
        timezone: storeTimezone,
      },
      metadata:
        session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
          ? (session.metadata as Record<string, unknown>)
          : {},
    };
  }
}
