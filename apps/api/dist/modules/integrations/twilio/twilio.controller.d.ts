import { RawBodyRequest } from '@nestjs/common';
import { Request, Response } from 'express';
import { TwilioSignatureService } from './twilio-signature.service';
import { TwilioWebhookService } from './twilio-webhook.service';
import { TwilioStatusCallbackService } from './twilio-status-callback.service';
import { ConfigService } from '@nestjs/config';
import { TwilioTtsCacheService } from './twilio-tts-cache.service';
export declare class TwilioVoiceController {
    private readonly signature;
    private readonly statusCallback;
    private readonly config;
    private readonly ttsCache;
    private readonly voiceWebhooks;
    constructor(signature: TwilioSignatureService, statusCallback: TwilioStatusCallbackService, config: ConfigService, ttsCache: TwilioTtsCacheService, voiceWebhooks: TwilioWebhookService);
    private readonly logger;
    configCheck(): {
        status: string;
        ready: boolean;
        signatureValidationEnabled: boolean;
        callFlow: {
            incomingVoiceWebhookOwner: string;
            inboundCallMode: string;
            llmProvider: string;
            liveElevenLabsInboundSupported: boolean;
        };
        checks: {
            publicWebhookBaseUrlSet: boolean;
            publicWebhookBaseUrlPublicHttps: boolean;
            twilioAuthTokenSet: boolean;
            elevenLabsApiKeySet: boolean;
        };
        missing: string[];
        notes: string[];
        recommendedTwilioConfig: {
            incomingCallWebhook: string;
            legacyIncomingCallWebhook: string;
            gatherWebhook: string;
            deferredPollWebhook: string;
            statusCallbackWebhook: string;
            httpMethod: string;
        };
    };
    liveCallReady(): {
        status: string;
        ready: boolean;
        twilio: {
            status: string;
            ready: boolean;
            signatureValidationEnabled: boolean;
            callFlow: {
                incomingVoiceWebhookOwner: string;
                inboundCallMode: string;
                llmProvider: string;
                liveElevenLabsInboundSupported: boolean;
            };
            checks: {
                publicWebhookBaseUrlSet: boolean;
                publicWebhookBaseUrlPublicHttps: boolean;
                twilioAuthTokenSet: boolean;
                elevenLabsApiKeySet: boolean;
            };
            missing: string[];
            notes: string[];
            recommendedTwilioConfig: {
                incomingCallWebhook: string;
                legacyIncomingCallWebhook: string;
                gatherWebhook: string;
                deferredPollWebhook: string;
                statusCallbackWebhook: string;
                httpMethod: string;
            };
        };
        env: {
            ok: boolean;
            missing: string[];
        };
        runtime: {
            inboundVoiceWebhookOwner: string;
            inboundCallMode: string;
            llmProvider: string;
            liveElevenLabsInboundSupported: boolean;
        };
        checks: {
            openAiKeySet: boolean;
            elevenLabsKeySet: boolean;
            encryptionKeySet: boolean;
            jwtSecretSet: boolean;
        };
    };
    ttsAudio(token: string, res: Response): void;
    inbound(req: RawBodyRequest<Request>, res: Response, body: Record<string, string>, signature: string): Promise<void>;
    inboundLegacy(req: RawBodyRequest<Request>, res: Response, body: Record<string, string>, signature: string): Promise<void>;
    gather(req: RawBodyRequest<Request>, res: Response, body: Record<string, string>, callSessionId: string | undefined, signature: string): Promise<void>;
    deferredPoll(req: RawBodyRequest<Request>, res: Response, body: Record<string, string>, callSessionId: string | undefined, signature: string): Promise<void>;
    status(req: RawBodyRequest<Request>, res: Response, body: Record<string, string>, signature: string): Promise<Response<any, Record<string, any>>>;
}
