import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import { EncryptionService } from '../../../common/encryption.service';
import { normalizePublicWebhookBaseUrl } from '../../../common/public-webhook-base-url';
import { normalizePhoneNumber } from '../../integrations/twilio/utils/normalize-phone';
import {
  openAiKeyLayerPresence,
  resolveElevenLabsKeyChain,
  resolveOpenAiKeyChain,
  type VoiceCredentialSource,
} from './voice-config-resolution.util';
import { gatedProcessEnv } from '../../../common/provider-env-slice.util';

export type VoiceConfigCheckResponse = {
  resolvedAgentId: string;
  tenantId: string;
  openaiKeySource: VoiceCredentialSource;
  openaiKeyPresent: boolean;
  /** Non-empty OpenAI key in agent secretsEnc (before precedence). */
  agentOpenaiKeyStored: boolean;
  /** Workspace OpenAI ciphertext on file. */
  tenantOpenaiKeyStored: boolean;
  /** Same as agentOpenaiKeyStored (ops-friendly name). */
  agentKeyPresent: boolean;
  /** Same as tenantOpenaiKeyStored (workspace Settings key row present). */
  tenantKeyPresent: boolean;
  /** OPENAI_API_KEY in environment is non-empty. */
  envKeyPresent: boolean;
  /** True when both agent and workspace have OpenAI material; runtime uses agent. */
  agentOverridesWorkspaceOpenai: boolean;
  model: string | null;
  voiceProvider: string | null;
  voiceIdPresent: boolean;
  elevenLabsKeySource: VoiceCredentialSource;
  publicWebhookBaseUrlValid: boolean;
  twilioNumberMapped: boolean;
  warnings: string[];
};

@Injectable()
export class VoiceConfigCheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
  ) {}

  async check(tenantId: string, agentId: string): Promise<VoiceConfigCheckResponse> {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId, deletedAt: null },
      select: {
        id: true,
        model: true,
        voiceProvider: true,
        voiceId: true,
        twilioPhoneNumber: true,
        secretsEnc: true,
        agentConfig: {
          select: { useWorkspaceOpenai: true, useWorkspaceElevenlabs: true },
        },
      },
    });
    if (!agent) throw new NotFoundException('Agent not found.');

    const useWorkspaceOpenai = agent.agentConfig?.useWorkspaceOpenai === true;
    const useWorkspaceElevenlabs = agent.agentConfig?.useWorkspaceElevenlabs === true;

    const warnings: string[] = [];

    let agentOpenaiPlain: string | null = null;
    let agentElevenPlain: string | null = null;
    if (agent.secretsEnc && this.encryption.isAvailable()) {
      const dec = this.encryption.decryptFromStorage(agent.secretsEnc);
      if (dec) {
        try {
          const secrets = JSON.parse(dec) as { openaiApiKey?: string; elevenlabsApiKey?: string };
          agentOpenaiPlain = typeof secrets.openaiApiKey === 'string' ? secrets.openaiApiKey : null;
          agentElevenPlain = typeof secrets.elevenlabsApiKey === 'string' ? secrets.elevenlabsApiKey : null;
        } catch {
          warnings.push('agent_secretsEnc_not_json');
        }
      }
    }

    const ti = this.encryption.isAvailable()
      ? await this.prisma.tenantIntegration.findUnique({
          where: { tenantId },
          select: { openaiApiKeyEnc: true, elevenlabsApiKeyEnc: true, elevenlabsDefaultVoiceId: true },
        })
      : null;

    const encAvail = this.encryption.isAvailable();
    if (!encAvail) {
      warnings.push('encryption_not_configured_tenant_keys_unreadable');
    }

    const openaiEnvPlain = gatedProcessEnv('OPENAI_API_KEY', this.config);
    const openaiR = resolveOpenAiKeyChain({
      agentSecretPlain: agentOpenaiPlain,
      tenantEnc: ti?.openaiApiKeyEnc ?? null,
      decryptFromStorage: (s) => this.encryption.decryptFromStorage(s),
      envPlain: openaiEnvPlain,
      encryptionAvailable: encAvail,
      useWorkspaceOpenai,
    });
    const openaiLayers = openAiKeyLayerPresence({
      agentSecretPlain: agentOpenaiPlain,
      tenantEnc: ti?.openaiApiKeyEnc ?? null,
      envPlain: openaiEnvPlain,
      useWorkspaceOpenai,
    });
    const agentOpenaiKeyStored = openaiLayers.agentKeyPresent;
    const tenantOpenaiKeyStored = openaiLayers.tenantKeyPresent;
    const envKeyPresent = openaiLayers.envKeyPresent;
    const agentOverridesWorkspaceOpenai = agentOpenaiKeyStored && tenantOpenaiKeyStored;

    const elevenR = resolveElevenLabsKeyChain({
      agentSecretPlain: agentElevenPlain,
      tenantEnc: ti?.elevenlabsApiKeyEnc ?? null,
      decryptFromStorage: (s) => this.encryption.decryptFromStorage(s),
      envPlain: gatedProcessEnv('ELEVENLABS_API_KEY', this.config),
      encryptionAvailable: encAvail,
      useWorkspaceElevenlabs,
    });

    if (agentOverridesWorkspaceOpenai) {
      warnings.push('agent_openai_key_overrides_workspace_openai_key');
    }
    if (elevenR.source === 'agent' && ti?.elevenlabsApiKeyEnc) {
      warnings.push(
        'workspace_elevenlabs_key_is_saved_but_per_agent_secret_takes_precedence',
      );
    }

    const normalizedTwilio =
      agent.twilioPhoneNumber?.trim() ? normalizePhoneNumber(agent.twilioPhoneNumber.trim()) : null;
    const mappingCount = normalizedTwilio
      ? await this.prisma.phoneNumberMapping.count({
          where: { tenantId, phoneNumber: normalizedTwilio, agentId: agent.id },
        })
      : 0;
    const twilioNumberMapped = Boolean(normalizedTwilio && mappingCount > 0);

    if (normalizedTwilio && !twilioNumberMapped) {
      warnings.push('twilio_number_on_agent_not_found_in_phone_number_mapping');
    }

    const origin = normalizePublicWebhookBaseUrl(this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL'));
    const publicWebhookBaseUrlValid = /^https:\/\//i.test(origin);

    if (!publicWebhookBaseUrlValid) {
      warnings.push('public_webhook_base_url_must_be_https_for_elevenlabs_playback');
    }

    const gatherDebugRaw = `${this.config.get<string>('TWILIO_GATHER_HEARING_DEBUG') ?? process.env.TWILIO_GATHER_HEARING_DEBUG ?? ''}`.trim();
    const twilioGatherHearingDebug = gatherDebugRaw === '1' || gatherDebugRaw.toLowerCase() === 'true';
    const forceElRaw = `${this.config.get<string>('FORCE_ELEVENLABS_ONLY') ?? process.env.FORCE_ELEVENLABS_ONLY ?? ''}`.trim();
    const forceElevenLabsOnly = forceElRaw === '1' || forceElRaw.toLowerCase() === 'true';

    if (twilioGatherHearingDebug) {
      warnings.push(
        'TWILIO_GATHER_HEARING_DEBUG=true: fixed Gather prompts can use Twilio <Say> (Polly) instead of ElevenLabs <Play>, which disables ElevenLabs for those scripted lines and often sounds like a second voice in production.',
      );
      if (forceElevenLabsOnly) {
        warnings.push(
          'FORCE_ELEVENLABS_ONLY=true overrides TWILIO_GATHER_HEARING_DEBUG for scripted prompts: ElevenLabs <Play> is still used unless ElevenLabs fails, the ElevenLabs voice ID is missing, or PUBLIC_WEBHOOK_BASE_URL is not HTTPS.',
        );
      }
    } else if (forceElevenLabsOnly) {
      warnings.push(
        'FORCE_ELEVENLABS_ONLY=true: customer-facing speech should use ElevenLabs <Play> with the configured voice ID; Twilio <Say> is only used as an explicit fallback when ElevenLabs cannot run.',
      );
    }

    const workspaceDefaultVoice = ti?.elevenlabsDefaultVoiceId?.trim() || null;
    const voiceIdEffective = agent.voiceId?.trim() || workspaceDefaultVoice;
    const vp = (agent.voiceProvider ?? '').toLowerCase().trim();

    return {
      resolvedAgentId: agent.id,
      tenantId,
      openaiKeySource: openaiR.source,
      openaiKeyPresent: Boolean(openaiR.value?.trim()),
      agentOpenaiKeyStored,
      tenantOpenaiKeyStored,
      agentKeyPresent: agentOpenaiKeyStored,
      tenantKeyPresent: tenantOpenaiKeyStored,
      envKeyPresent,
      agentOverridesWorkspaceOpenai,
      model: agent.model ?? null,
      voiceProvider: agent.voiceProvider ?? null,
      voiceIdPresent: Boolean(vp === 'elevenlabs' && voiceIdEffective),
      elevenLabsKeySource: elevenR.source,
      publicWebhookBaseUrlValid,
      twilioNumberMapped,
      warnings,
    };
  }
}
