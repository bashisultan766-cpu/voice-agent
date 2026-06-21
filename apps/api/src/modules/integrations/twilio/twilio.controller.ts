import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  Res,
  Headers,
  BadRequestException,
  RawBodyRequest,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { TwilioSignatureService } from './twilio-signature.service';
import { TwilioWebhookService, type DeferredPollInboundPayload } from './twilio-webhook.service';
import { TwilioStatusCallbackService } from './twilio-status-callback.service';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../../common/decorators/public.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { redactSecrets } from '../../../common/logging/safe-log';
import { validateProductionEnv } from '../../../common/env-validation';
import { allowProviderEnvFallback } from '../../../common/provider-env-fallback.util';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { AgentsService } from '../../agents/agents.service';
import { TwilioTtsCacheService } from './twilio-tts-cache.service';
import { normalizePublicWebhookBaseUrl, validatePublicWebhookBaseUrl } from '../../../common/public-webhook-base-url';
import { buildFallbackTwiML } from './twiml/conversation-relay.twiml';
import { resolveVoiceProviderPolicy } from './voice-provider-policy.util';
import { computeGatherSpeechGate } from './gather-speech-gate.util';
import { LegacyVoicePipelineGuard } from '../../../common/guards/legacy-voice-pipeline.guard';

const inboundSchema = z.object({
  CallSid: z.string().trim().min(1),
  From: z.string().trim().min(3),
  To: z.string().trim().min(3),
});

const gatherSchema = z.object({
  CallSid: z.string().trim().min(1),
  From: z.string().trim().min(3),
  To: z.string().trim().min(3),
  SpeechResult: z.string().max(4000).optional(),
  StableSpeechResult: z.string().max(4000).optional(),
  Confidence: z.string().trim().optional(),
});

const statusSchema = z.object({
  CallSid: z.string().trim().min(1),
  CallStatus: z.string().trim().min(1),
  CallDuration: z.string().optional(),
  RecordingUrl: z.string().optional(),
  Direction: z.string().optional(),
  From: z.string().optional(),
  To: z.string().optional(),
  ErrorCode: z.string().optional(),
  ErrorMessage: z.string().optional(),
  Timestamp: z.string().optional(),
});

@Controller('twilio')
export class TwilioVoiceController {
  constructor(
    private readonly signature: TwilioSignatureService,
    private readonly statusCallback: TwilioStatusCallbackService,
    private readonly config: ConfigService,
    private readonly ttsCache: TwilioTtsCacheService,
    private readonly voiceWebhooks: TwilioWebhookService,
    private readonly agents: AgentsService,
  ) {}
  private readonly logger = new Logger(TwilioVoiceController.name);

  private blockTwilioSayInVoice(): boolean {
    return resolveVoiceProviderPolicy({
      FORCE_ELEVENLABS_ONLY:
        this.config.get<string>('FORCE_ELEVENLABS_ONLY') ?? process.env.FORCE_ELEVENLABS_ONLY,
      STRICT_ELEVENLABS_ONLY:
        this.config.get<string>('STRICT_ELEVENLABS_ONLY') ?? process.env.STRICT_ELEVENLABS_ONLY,
      FORCE_TWILIO_FALLBACK:
        this.config.get<string>('FORCE_TWILIO_FALLBACK') ?? process.env.FORCE_TWILIO_FALLBACK,
    }).twilioSayBlocked;
  }

  /**
   * Twilio configuration readiness check.
   * Useful before go-live to verify required env and generated webhook URLs.
   */
  @Roles(UserRole.MANAGER)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('config-check')
  configCheck() {
    const baseUrlRaw = this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL') ?? '';
    const baseUrl = normalizePublicWebhookBaseUrl(baseUrlRaw);
    const validateSignatures = this.signature.isValidationEnabled();
    const envFallback = allowProviderEnvFallback();
    const hasTwilioAuthToken =
      Boolean((this.config.get<string>('TWILIO_AUTH_TOKEN') ?? '').trim()) || !envFallback;
    const hasElevenLabsApiKey =
      Boolean((this.config.get<string>('ELEVENLABS_API_KEY') ?? '').trim()) || !envFallback;
    const webhookBaseValidation = validatePublicWebhookBaseUrl(baseUrlRaw);
    const hasPublicWebhookBaseUrl = Boolean(baseUrl);
    const isPublicHttps = webhookBaseValidation.ok;

    const requiredChecks = {
      publicWebhookBaseUrlSet: hasPublicWebhookBaseUrl,
      publicWebhookBaseUrlPublicHttps: isPublicHttps,
      twilioAuthTokenSet: hasTwilioAuthToken,
      elevenLabsApiKeySet: hasElevenLabsApiKey,
    };

    const missing: string[] = [];
    if (!requiredChecks.publicWebhookBaseUrlSet) missing.push('PUBLIC_WEBHOOK_BASE_URL');
    if (!requiredChecks.publicWebhookBaseUrlPublicHttps) {
      missing.push(
        `PUBLIC_WEBHOOK_BASE_URL must be public HTTPS (no localhost/ngrok/example/localtunnel). reason=${webhookBaseValidation.reason ?? 'invalid'}`,
      );
    }
    if (
      validateSignatures &&
      envFallback &&
      !Boolean((this.config.get<string>('TWILIO_AUTH_TOKEN') ?? '').trim())
    ) {
      missing.push('TWILIO_AUTH_TOKEN (required when ALLOW_PROVIDER_ENV_FALLBACK=true and signature validation is enabled)');
    }

    const ready = missing.length === 0;

    return {
      status: ready ? 'ready' : 'not_ready',
      ready,
      signatureValidationEnabled: validateSignatures,
      callFlow: {
        incomingVoiceWebhookOwner: 'this_app',
        inboundCallMode: 'twilio-gather-mvp',
        llmProvider: 'openai',
        liveElevenLabsInboundSupported: hasElevenLabsApiKey,
      },
      checks: requiredChecks,
      missing,
      credentialMode: envFallback ? 'env_fallback_allowed' : 'per_agent_db_only',
      notes: [
        'Provider API keys (OpenAI, ElevenLabs, Twilio, Shopify, Resend) are loaded per agent from the database unless ALLOW_PROVIDER_ENV_FALLBACK=true.',
        'Configure your Twilio phone number to POST incoming calls to this app, not to the ElevenLabs native Twilio URL.',
        'Live inbound calls use Twilio webhooks plus Twilio Gather; OpenAI generates reply text.',
        'Inbound greeting uses Twilio <Say> only (fast webhook). After each user utterance, the app returns an instant <Say> then polls /api/twilio/voice/deferred-poll until OpenAI + optional ElevenLabs complete.',
        'Set PUBLIC_WEBHOOK_BASE_URL to your HTTPS origin only (no trailing /api).',
        'Set TWILIO_GATHER_HEARING_DEBUG=true to force the first Gather leg to Twilio <Say> only (no ElevenLabs greeting), timeout=12, speechTimeout=3, for speech-capture debugging.',
        'VOICE_DEFERRED_JOB_TIMEOUT_MS (default 55000, minimum 50000): background budget for OpenAI+Shopify+ElevenLabs; values below 50s are raised to avoid false timeouts when TTS alone takes ~10–15s.',
        'If logs show reason twilio_gather_hearing_debug on phrase_audio, set TWILIO_GATHER_HEARING_DEBUG=false for ElevenLabs on scripted prompts.',
      ],
      recommendedTwilioConfig: {
        incomingCallWebhook: `${baseUrl}/api/twilio/voice/inbound`,
        legacyIncomingCallWebhook: `${baseUrl}/api/twilio/inbound_call`,
        gatherWebhook: `${baseUrl}/api/twilio/voice/gather?callSessionId={sessionId}`,
        deferredPollWebhook: `${baseUrl}/api/twilio/voice/deferred-poll?callSessionId={sessionId}`,
        statusCallbackWebhook: `${baseUrl}/api/twilio/voice/status`,
        httpMethod: 'POST',
      },
    };
  }

  /**
   * Aggregate readiness for a real phone call test (Twilio + core secrets).
   * Set LIVE_CALL_TEST_MODE=true to enforce stricter env checks via validateProductionEnv().
   */
  @Roles(UserRole.MANAGER)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('live-call-ready')
  async liveCallReady(@TenantId() tenantId: string, @Query('agentId') agentId?: string) {
    const twilio = this.configCheck();
    const env = validateProductionEnv();
    const encryption = Boolean((this.config.get<string>('ENCRYPTION_KEY') ?? '').trim());
    const jwt = Boolean((this.config.get<string>('JWT_SECRET') ?? '').trim());

    let openAi = allowProviderEnvFallback()
      ? Boolean((this.config.get<string>('OPENAI_API_KEY') ?? '').trim())
      : true;
    let elevenLabs = allowProviderEnvFallback()
      ? Boolean((this.config.get<string>('ELEVENLABS_API_KEY') ?? '').trim())
      : true;
    let agentCredentialSummary: Awaited<ReturnType<AgentsService['getCredentialSourcesSummary']>> | null =
      null;

    const trimmedAgentId = agentId?.trim();
    if (trimmedAgentId) {
      agentCredentialSummary = await this.agents.getCredentialSourcesSummary(tenantId, trimmedAgentId);
      openAi = agentCredentialSummary.openai.configured;
      elevenLabs = agentCredentialSummary.elevenlabs.configured;
    }

    const ready = twilio.ready && env.ok && openAi && elevenLabs && encryption && jwt;
    return {
      status: ready ? 'ready' : 'not_ready',
      ready,
      twilio,
      env,
      agentId: trimmedAgentId ?? null,
      agentCredentialSources: agentCredentialSummary,
      runtime: {
        inboundVoiceWebhookOwner: 'this_app',
        inboundCallMode: 'twilio-gather-mvp',
        llmProvider: 'openai',
        liveElevenLabsInboundSupported: elevenLabs,
      },
      checks: {
        openAiKeySet: openAi,
        elevenLabsKeySet: elevenLabs,
        encryptionKeySet: encryption,
        jwtSecretSet: jwt,
        agentIdProvided: Boolean(trimmedAgentId),
      },
      notes: trimmedAgentId
        ? []
        : [
            'Pass ?agentId=<uuid> to validate per-agent OpenAI and ElevenLabs credentials from the agent form.',
          ],
    };
  }

  /**
   * Public short-lived audio file used by Twilio <Play>.
   * Tokens are one-time use and expire in memory.
   */
  @Public()
  @SkipThrottle()
  @UseGuards(LegacyVoicePipelineGuard)
  @Get('voice/tts/:token')
  ttsAudio(@Param('token') token: string, @Res() res: Response) {
    const trimmed = token?.trim() ?? '';
    const audio = this.ttsCache.take(trimmed);
    if (!audio) throw new BadRequestException('TTS audio is missing or expired');
    this.logger.log(
      JSON.stringify({
        event: 'voice.tts.playback_started',
        provider: 'elevenlabs',
        tokenPrefix: trimmed.slice(0, 8),
        audioBytes: audio.length,
        contentType: 'audio/mpeg',
      }),
    );
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(audio);
  }

  /**
   * Twilio voice webhook: incoming call.
   * Configure this URL on your Twilio number: POST /api/twilio/voice/inbound
   * Signature validation is mandatory when VALIDATE_TWILIO_SIGNATURES is not false.
   */
  @Public()
  @SkipThrottle()
  @UseGuards(LegacyVoicePipelineGuard)
  @Post('voice/inbound')
  async inbound(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Body() body: Record<string, string>,
    @Headers('x-twilio-signature') signature: string,
  ) {
    console.log('Inbound webhook hit');
    try {
      const url = this.signature.resolveValidationUrl(req);
      if (this.signature.isValidationEnabled()) {
        if (!signature) throw new BadRequestException('Missing Twilio signature');
        const valid = await this.signature.validateInbound(url, body as Record<string, string>, signature);
        if (!valid) {
          this.logger.warn(
            JSON.stringify({
              event: 'twilio.voice.signature_invalid',
              route: 'inbound',
              payload: redactSecrets(body),
            }),
          );
          throw new BadRequestException('Invalid Twilio signature');
        }
      }
      const parsedInbound = inboundSchema.safeParse(body);
      if (!parsedInbound.success) {
        throw new BadRequestException('Invalid Twilio inbound payload.');
      }

      const { twiml } = await this.voiceWebhooks.handleInboundVoice({
        CallSid: parsedInbound.data.CallSid,
        From: parsedInbound.data.From,
        To: parsedInbound.data.To,
      });

      res.type('text/xml; charset=utf-8').send(twiml);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        JSON.stringify({
          event: 'twilio.voice.inbound_error',
          message: message.slice(0, 400),
        }),
      );
      const twiml = buildFallbackTwiML('Sorry, something went wrong. Please try your call again.', {
        blockTwilioSay: false,
      });
      res.type('text/xml; charset=utf-8').status(200).send(twiml);
    }
  }

  /**
   * Compatibility webhook path for legacy Twilio setups.
   * Some configs use /api/twilio/inbound_call; keep this mapped to the same inbound logic.
   */
  @Public()
  @SkipThrottle()
  @UseGuards(LegacyVoicePipelineGuard)
  @Post('inbound_call')
  async inboundLegacy(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Body() body: Record<string, string>,
    @Headers('x-twilio-signature') signature: string,
  ) {
    console.log('Inbound webhook hit (legacy inbound_call)');
    const url = this.signature.resolveValidationUrl(req);
    if (this.signature.isValidationEnabled()) {
      if (!signature) throw new BadRequestException('Missing Twilio signature');
      const valid = await this.signature.validateInbound(url, body as Record<string, string>, signature);
      if (!valid) {
        this.logger.warn(
          JSON.stringify({
            event: 'twilio.voice.signature_invalid',
            route: 'inbound_legacy',
            payload: redactSecrets(body),
          }),
        );
        throw new BadRequestException('Invalid Twilio signature');
      }
    }
    const parsedInbound = inboundSchema.safeParse(body);
    if (!parsedInbound.success) {
      throw new BadRequestException('Invalid Twilio inbound payload.');
    }
    const { twiml } = await this.voiceWebhooks.handleInboundVoice({
      CallSid: parsedInbound.data.CallSid,
      From: parsedInbound.data.From,
      To: parsedInbound.data.To,
    });

    res.type('text/xml; charset=utf-8').send(twiml);
  }

  /**
   * Twilio Gather callback: usable speech → instant &lt;Say&gt; + Redirect to deferred-poll;
   * OpenAI + Shopify + ElevenLabs run asynchronously; deferred-poll returns &lt;Play&gt;/&lt;Say&gt; + Gather when ready.
   */
  @Public()
  @SkipThrottle()
  @UseGuards(LegacyVoicePipelineGuard)
  @Post('voice/gather')
  async gather(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Body() body: Record<string, string>,
    @Query('callSessionId') callSessionId: string | undefined,
    @Headers('x-twilio-signature') signature: string,
  ) {
    console.log('Gather webhook hit');
    try {
      const url = this.signature.resolveValidationUrl(req);
      if (this.signature.isValidationEnabled()) {
        if (!signature) throw new BadRequestException('Missing Twilio signature');
        const valid = await this.signature.validateInbound(url, body as Record<string, string>, signature);
        if (!valid) {
          this.logger.warn(
            JSON.stringify({
              event: 'twilio.voice.signature_invalid',
              route: 'gather',
              payload: redactSecrets(body),
            }),
          );
          throw new BadRequestException('Invalid Twilio signature');
        }
      }
      const parsedGather = gatherSchema.safeParse(body);
      if (!parsedGather.success) {
        throw new BadRequestException('Invalid Twilio gather payload.');
      }
      const g = parsedGather.data;

      const gate = computeGatherSpeechGate({
        SpeechResult: g.SpeechResult,
        StableSpeechResult: g.StableSpeechResult,
        Confidence: g.Confidence,
      });
      const speechCaptured = Boolean(
        (g.SpeechResult ?? '').trim() || (g.StableSpeechResult ?? '').trim(),
      );
      const maskPhoneTail = (value: string): string => {
        const digits = value.replace(/\D/g, '');
        if (digits.length < 4) return '***';
        return `****${digits.slice(-4)}`;
      };
      const fullGatherBody: Record<string, string> = { ...(body as Record<string, string>) };
      if (fullGatherBody.From) fullGatherBody.From = maskPhoneTail(fullGatherBody.From);
      if (fullGatherBody.To) fullGatherBody.To = maskPhoneTail(fullGatherBody.To);

      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.gather_handler_proof',
          route: '/api/twilio/voice/gather',
          fullGatherBody,
          SpeechResult: g.SpeechResult ?? '',
          StableSpeechResult: g.StableSpeechResult ?? '',
          Confidence: g.Confidence ?? '',
          hasUsableSpeech: gate.hasUsableSpeech,
          willCallVoiceRuntime: gate.willCallVoiceRuntime,
          deferredVoiceJobQueued: gate.willCallVoiceRuntime,
          speechCapturedFromTwilio: speechCaptured,
          callSessionIdQuery: callSessionId?.trim() ?? null,
          CallSid: g.CallSid,
          ...(speechCaptured
            ? {}
            : {
                diagnosis:
                  'OpenAI key is not the cause. Twilio did not capture speech.',
              }),
        }),
      );

      const { twiml } = await this.voiceWebhooks.handleGatherMvpVoice({
        CallSid: g.CallSid,
        From: g.From,
        To: g.To,
        SpeechResult: g.SpeechResult,
        StableSpeechResult: g.StableSpeechResult,
        Confidence: g.Confidence,
        callSessionId: callSessionId?.trim() || undefined,
      });

      res.type('text/xml; charset=utf-8').send(twiml);
    } catch (error) {
      console.error(error);
      if (error instanceof BadRequestException) throw error;
      const twiml = buildFallbackTwiML('Sorry, something went wrong. Please try your call again.', {
        blockTwilioSay: this.blockTwilioSayInVoice(),
      });
      res.type('text/xml; charset=utf-8').send(twiml);
    }
  }

  /**
   * Deferred voice poll: cheap TwiML only (Pause / Redirect) until async OpenAI + ElevenLabs complete.
   */
  @Public()
  @SkipThrottle()
  @UseGuards(LegacyVoicePipelineGuard)
  @Post('voice/deferred-poll')
  async deferredPoll(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Body() body: Record<string, string>,
    @Query('callSessionId') callSessionId: string | undefined,
    @Headers('x-twilio-signature') signature: string,
  ) {
    try {
      const url = this.signature.resolveValidationUrl(req);
      if (this.signature.isValidationEnabled()) {
        if (!signature) throw new BadRequestException('Missing Twilio signature');
        const valid = await this.signature.validateInbound(url, body as Record<string, string>, signature);
        if (!valid) {
          this.logger.warn(
            JSON.stringify({
              event: 'twilio.voice.signature_invalid',
              route: 'deferred-poll',
              payload: redactSecrets(body),
            }),
          );
          throw new BadRequestException('Invalid Twilio signature');
        }
      }
      const parsed = gatherSchema.safeParse(body);
      if (!parsed.success) {
        throw new BadRequestException('Invalid Twilio deferred-poll payload.');
      }
      const g = parsed.data;
      const payload: DeferredPollInboundPayload = {
        CallSid: g.CallSid,
        From: g.From,
        To: g.To,
        callSessionId: callSessionId?.trim() || undefined,
      };
      const { twiml } = await this.voiceWebhooks.handleDeferredVoicePoll(payload);
      res.type('text/xml; charset=utf-8').send(twiml);
    } catch (error) {
      console.error(error);
      if (error instanceof BadRequestException) throw error;
      const twiml = buildFallbackTwiML('Sorry, something went wrong. Please try your call again.', {
        blockTwilioSay: this.blockTwilioSayInVoice(),
      });
      res.type('text/xml; charset=utf-8').send(twiml);
    }
  }

  /**
   * Twilio status callback.
   * Configure statusCallback URL on Twilio to receive completed/failed/no-answer.
   */
  @Public()
  @SkipThrottle()
  @UseGuards(LegacyVoicePipelineGuard)
  @Post('voice/status')
  async status(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Body() body: Record<string, string>,
    @Headers('x-twilio-signature') signature: string,
  ) {
    try {
      const url = this.signature.resolveValidationUrl(req);
      if (this.signature.isValidationEnabled()) {
        if (!signature) {
          this.logger.warn(JSON.stringify({ event: 'twilio.voice.status_missing_signature' }));
          return res.status(200).send('OK');
        }
        const valid = await this.signature.validateInbound(url, body as Record<string, string>, signature);
        if (!valid) {
          this.logger.warn(
            JSON.stringify({
              event: 'twilio.voice.signature_invalid',
              route: 'status',
              payload: redactSecrets(body),
            }),
          );
          return res.status(200).send('OK');
        }
      }
      const parsedStatus = statusSchema.safeParse(body);
      if (!parsedStatus.success) {
        console.error('Twilio status error: invalid payload', parsedStatus.error.flatten());
        return res.status(200).send('OK');
      }
      const parsed = parsedStatus.data;
      await this.statusCallback.handleStatus({
        CallSid: parsed.CallSid,
        CallStatus: parsed.CallStatus,
        CallDuration: parsed.CallDuration,
        RecordingUrl: parsed.RecordingUrl,
        Direction: parsed.Direction,
        From: parsed.From,
        To: parsed.To,
        ErrorCode: parsed.ErrorCode,
        ErrorMessage: parsed.ErrorMessage,
        Timestamp: parsed.Timestamp,
      });
    } catch (error) {
      console.error('Twilio status error:', error);
    }
    return res.status(200).send('OK');
  }
}
