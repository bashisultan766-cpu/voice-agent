import { Injectable, OnModuleInit } from '@nestjs/common';
import { VoiceEventBusService } from '../events/voice-event-bus.service';
import { VoiceE2ETraceService } from './voice-e2e-trace.service';

/** Maps in-process voice bus events to E2E trace steps for production observability. */
@Injectable()
export class VoiceE2EObservabilityListener implements OnModuleInit {
  constructor(
    private readonly bus: VoiceEventBusService,
    private readonly trace: VoiceE2ETraceService,
  ) {}

  onModuleInit(): void {
    this.bus.on('turn.received', (e) => {
      void this.trace.record(e.payload.callSessionId, 'transcript_final', {
        metadata: { text: e.payload.text?.slice(0, 200) },
      });
    });

    this.bus.on('agent.completed', (e) => {
      const agent = e.payload.agent ?? e.payload.result?.agent;
      const callSessionId = e.payload.callSessionId;
      const latencyMs = e.payload.result?.latencyMs ?? e.payload.latencyMs;
      if (agent === 'shopify_search' || agent === 'isbn_search') {
        void this.trace.record(callSessionId, 'product_search_completed', {
          latencyMs,
          ok: e.payload.result?.ok ?? true,
          provider: 'shopify',
          metadata: { agent },
        });
      }
      if (agent === 'email_verification') {
        void this.trace.record(callSessionId, 'email_verified', {
          latencyMs,
          ok: e.payload.result?.ok ?? true,
          provider: 'email_validation',
        });
      }
      if (agent === 'payment_link') {
        const data = e.payload.result?.data as Record<string, unknown> | undefined;
        if (data?.checkoutLinkId) {
          void this.trace.record(callSessionId, 'checkout_created', {
            latencyMs,
            ok: true,
            provider: 'shopify_checkout',
            metadata: { checkoutLinkId: data.checkoutLinkId },
          });
        }
        if (data?.sent) {
          void this.trace.record(callSessionId, 'email_sent', {
            latencyMs,
            ok: true,
            provider: 'resend',
          });
        }
      }
    });

    this.bus.on('agent.failed', (e) => {
      const agent = e.payload.agent ?? e.payload.result?.agent ?? 'unknown';
      void this.trace.record(e.payload.callSessionId, 'product_search_completed', {
        ok: false,
        provider: String(agent),
        error: e.payload.result?.error ?? 'agent_failed',
        metadata: { failedAgent: agent },
      });
    });
  }
}
