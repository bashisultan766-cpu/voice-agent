import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';
import type { WebSocket as WebSocketType } from 'ws';
import { SessionContextService } from '../../calls/runtime/session-context.service';
import { CallsService } from '../../calls/calls.service';
import { TranscriptBufferService } from '../../calls/runtime/transcript-buffer.service';
import { RealtimeVoiceOrchestratorService } from '../orchestrator/realtime-voice-orchestrator.service';
import { VoiceEventBusService } from '../events/voice-event-bus.service';
import { OpenAiRealtimeBridgeService } from './openai-realtime-bridge.service';
import { RealtimeVoiceMetricsService } from './realtime-voice-metrics.service';
import { MediaStreamFallbackService } from './media-stream-fallback.service';
import { VoiceE2ETraceService } from '../observability/voice-e2e-trace.service';
import { ElevenLabsWsTtsSession } from './elevenlabs-ws-tts';
import type { OpenAiRealtimeBridge } from './openai-realtime-bridge';
import {
  buildTwilioClearPayload,
  buildTwilioMarkPayload,
  buildTwilioMediaPayload,
  splitTextForStreamingTts,
} from './twilio-media-protocol.util';
import { isElevenLabsStreamingTtsEnabled } from '../config/realtime-voice-flags.util';
import type { ConversationTurn } from '../types/voice-turn.types';

export type MediaStreamSessionState = {
  callSessionId: string;
  callSid: string;
  streamSid: string;
  twilioWs: WebSocketType;
  history: ConversationTurn[];
  openaiBridge: OpenAiRealtimeBridge | null;
  ttsAbort: AbortController | null;
  speaking: boolean;
  processing: boolean;
  connectedAt: number;
  firstAudioSent: boolean;
};

@Injectable()
export class FullDuplexPipelineService {
  private readonly logger = new Logger(FullDuplexPipelineService.name);
  private readonly sessions = new Map<string, MediaStreamSessionState>();

  constructor(
    private readonly sessionContext: SessionContextService,
    private readonly callsService: CallsService,
    private readonly transcriptBuffer: TranscriptBufferService,
    private readonly orchestrator: RealtimeVoiceOrchestratorService,
    private readonly openaiBridgeService: OpenAiRealtimeBridgeService,
    private readonly metrics: RealtimeVoiceMetricsService,
    private readonly fallback: MediaStreamFallbackService,
    private readonly events: VoiceEventBusService,
    private readonly e2eTrace: VoiceE2ETraceService,
  ) {}

  getSession(callSessionId: string): MediaStreamSessionState | undefined {
    return this.sessions.get(callSessionId);
  }

  async onTwilioConnected(
    twilioWs: WebSocketType,
    callSessionId: string,
    queryCallSessionId?: string,
  ): Promise<void> {
    const id = callSessionId || queryCallSessionId || '';
    if (!id) return;

    await this.metrics.record(id, {
      streamingStatus: 'listening',
      pipelineMode: 'full_duplex',
    });
  }

  async onTwilioStart(
    twilioWs: WebSocketType,
    callSessionId: string,
    streamSid: string,
    callSid: string,
  ): Promise<void> {
    const state: MediaStreamSessionState = {
      callSessionId,
      callSid,
      streamSid,
      twilioWs,
      history: [],
      openaiBridge: null,
      ttsAbort: null,
      speaking: false,
      processing: false,
      connectedAt: Date.now(),
      firstAudioSent: false,
    };
    this.sessions.set(callSessionId, state);

    if (!this.e2eTrace.resolveTraceId(callSessionId)) {
      this.e2eTrace.startTrace(callSessionId, 'live');
    }
    void this.e2eTrace.record(callSessionId, 'call_connected', { ok: true, provider: 'twilio' });
    await this.callsService.mergeSessionMetadata(callSessionId, {
      twilioStreamSid: streamSid,
      twilioCallSid: callSid,
      mediaStreamConnected: true,
      fullDuplexPipeline: true,
    });

    try {
      const ctx = await this.sessionContext.load(callSessionId);
      if (!ctx) throw new Error('session_context_missing');

      const apiKey = ctx.agent.openaiApiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) throw new Error('openai_api_key_missing');

      const bridge = await this.openaiBridgeService.createBridge({
        apiKey,
        instructions: 'Transcribe bookstore phone callers accurately. Do not generate responses.',
        onSpeechStart: () => void this.handleSpeechStart(callSessionId),
        onPartialTranscript: (partial) => void this.metrics.recordPartialTranscript(callSessionId, partial),
        onFinalTranscript: (text) => void this.handleFinalTranscript(callSessionId, text),
        onError: (err) => {
          this.logger.warn(JSON.stringify({ event: 'openai.realtime.error', callSessionId, message: err.message }));
        },
      });

      state.openaiBridge = bridge;

      this.logger.log(
        JSON.stringify({
          event: 'realtime.media_stream.pipeline_ready',
          callSessionId,
          streamSid,
          callSid,
        }),
      );

      await this.metrics.record(callSessionId, { streamingStatus: 'listening' });

      // Play greeting via TTS
      const greeting =
        ctx.agent.greetingMessage?.trim() ||
        `Hi! Thanks for calling ${ctx.store.name}. How can I help you find a book today?`;
      await this.speakText(callSessionId, greeting, { isGreeting: true });
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.error(
        JSON.stringify({ event: 'realtime.media_stream.pipeline_init_failed', callSessionId, reason }),
      );
      await this.triggerFallback(callSessionId, callSid, reason);
    }
  }

  onTwilioMedia(callSessionId: string, mulawPayload: string): void {
    const state = this.sessions.get(callSessionId);
    if (!state?.openaiBridge) return;
    state.openaiBridge.appendMulawAudio(mulawPayload);
  }

  async onTwilioStop(callSessionId: string): Promise<void> {
    void this.e2eTrace.record(callSessionId, 'call_ended', { ok: true, provider: 'twilio' });
    const traceId = this.e2eTrace.resolveTraceId(callSessionId);
    if (traceId) void this.e2eTrace.finishTrace(traceId);
    await this.teardown(callSessionId);
    await this.metrics.record(callSessionId, { streamingStatus: 'idle', agentSpeaking: false });
  }

  async onTwilioClose(callSessionId: string): Promise<void> {
    await this.teardown(callSessionId);
  }

  private async handleSpeechStart(callSessionId: string): Promise<void> {
    const state = this.sessions.get(callSessionId);
    if (!state) return;

    if (state.speaking || state.ttsAbort) {
      await this.cancelTts(callSessionId, 'user_barge_in');
      await this.metrics.recordBargeIn(callSessionId);
      this.events.emit('stream.interrupted', { callSessionId });
    }

    await this.metrics.record(callSessionId, { streamingStatus: 'listening', agentSpeaking: false });
    void this.e2eTrace.record(callSessionId, 'speech_started', { provider: 'openai_realtime' });
  }

  private async handleFinalTranscript(callSessionId: string, transcript: string): Promise<void> {
    const state = this.sessions.get(callSessionId);
    if (!state || state.processing) return;

    const trimmed = transcript.trim();
    if (!trimmed) return;

    state.processing = true;
    const turnStarted = Date.now();
    const sttLatencyMs = state.openaiBridge?.getSttLatencyMs() ?? null;

    await this.metrics.record(callSessionId, {
      streamingStatus: 'processing',
      sttLatencyMs,
      partialTranscript: trimmed.slice(0, 500),
    });

    const userSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
    await this.transcriptBuffer.append(callSessionId, 'user', trimmed, userSeq);
    void this.e2eTrace.record(callSessionId, 'transcript_final', {
      metadata: { text: trimmed.slice(0, 200) },
      provider: 'openai_realtime',
    });

    try {
      if (!this.orchestrator.isEnabled()) {
        await this.speakText(callSessionId, "One moment — I'm looking that up for you.");
        state.processing = false;
        return;
      }

      const result = await this.orchestrator.processUtterance(callSessionId, trimmed, state.history);
      const agentLatencyMs = result.totalLatencyMs;
      const shopifyResult = result.agentResults.find(
        (r) => r.agent === 'shopify_search' || r.agent === 'isbn_search',
      );
      const shopifyLatencyMs = shopifyResult?.latencyMs ?? null;

      await this.metrics.record(callSessionId, {
        agentLatencyMs,
        shopifyLatencyMs,
        llmLatencyMs: agentLatencyMs,
        searchLatencyMs: shopifyLatencyMs,
        totalVoiceTurnLatencyMs: Date.now() - turnStarted,
      });

      if (result.immediateFiller?.trim() && result.immediateFiller !== result.reply) {
        void this.e2eTrace.record(callSessionId, 'filler_started', {
          metadata: { filler: result.immediateFiller.slice(0, 120) },
        });
        await this.speakText(callSessionId, result.immediateFiller, { filler: true });
      }

      await this.speakText(callSessionId, result.reply);

      state.history.push({ role: 'user', content: trimmed }, { role: 'assistant', content: result.reply });
      if (state.history.length > 24) state.history = state.history.slice(-24);

      const agentSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
      await this.transcriptBuffer.append(callSessionId, 'agent', result.reply, agentSeq);
    } catch (err) {
      this.logger.error(
        JSON.stringify({
          event: 'realtime.media_stream.turn_failed',
          callSessionId,
          message: (err as Error).message,
        }),
      );
      await this.speakText(
        callSessionId,
        "I'm sorry — I hit a snag. Could you repeat that?",
      );
    } finally {
      state.processing = false;
      await this.metrics.record(callSessionId, { streamingStatus: 'listening' });
    }
  }

  private async speakText(
    callSessionId: string,
    text: string,
    opts?: { isGreeting?: boolean; filler?: boolean },
  ): Promise<void> {
    const state = this.sessions.get(callSessionId);
    if (!state || !text.trim()) return;

    if (!isElevenLabsStreamingTtsEnabled()) {
      await this.speakViaRestFallback(callSessionId, text);
      return;
    }

    const ctx = await this.sessionContext.load(callSessionId);
    if (!ctx) return;

    const apiKey = ctx.agent.elevenlabsApiKey?.trim() || process.env.ELEVENLABS_API_KEY?.trim();
    const voiceId = ctx.agent.voiceId?.trim() || process.env.ELEVENLABS_DEFAULT_VOICE_ID?.trim();
    if (!apiKey || !voiceId) {
      await this.speakViaRestFallback(callSessionId, text);
      return;
    }

    await this.cancelTts(callSessionId, 'new_utterance');
    const abort = new AbortController();
    state.ttsAbort = abort;
    state.speaking = true;
    await this.metrics.record(callSessionId, { streamingStatus: 'speaking', agentSpeaking: true });

    const chunks = splitTextForStreamingTts(text);
    let ttsFirstChunkMs: number | null = null;
    let chunksEmitted = 0;

    for (const chunk of chunks) {
      if (abort.signal.aborted) break;

      const tts = new ElevenLabsWsTtsSession({
        apiKey,
        voiceId,
        modelId: ctx.agent.elevenlabsModel?.trim() || process.env.ELEVENLABS_MODEL_ID,
        onAudioChunk: (mulawBase64, isFirst) => {
          if (abort.signal.aborted) return;
          this.sendMulawToTwilio(state, mulawBase64);
          chunksEmitted += 1;
          if (isFirst && !state.firstAudioSent) {
            state.firstAudioSent = true;
            const ttfa = Date.now() - state.connectedAt;
            void this.metrics.record(callSessionId, { timeToFirstAudioMs: ttfa });
          }
        },
        onError: (err) => {
          this.logger.warn(JSON.stringify({ event: 'elevenlabs.ws_tts.error', callSessionId, message: err.message }));
        },
      });

      const firstMs = await tts.speak(chunk, abort.signal);
      if (ttsFirstChunkMs === null && firstMs > 0) ttsFirstChunkMs = firstMs;

      const markName = tts.nextMarkName();
      if (state.twilioWs.readyState === state.twilioWs.OPEN) {
        state.twilioWs.send(buildTwilioMarkPayload(state.streamSid, markName));
      }
    }

    state.speaking = false;
    state.ttsAbort = null;
    await this.metrics.record(callSessionId, {
      streamingStatus: 'listening',
      agentSpeaking: false,
      ttsFirstChunkMs,
      ttsLatencyMs: ttsFirstChunkMs,
      chunksEmitted,
    });

    if (opts?.isGreeting) {
      this.logger.log(JSON.stringify({ event: 'realtime.media_stream.greeting_spoken', callSessionId }));
    }
  }

  private async speakViaRestFallback(callSessionId: string, text: string): Promise<void> {
    this.logger.warn(
      JSON.stringify({ event: 'realtime.media_stream.tts_rest_fallback', callSessionId, chars: text.length }),
    );
    // REST TTS requires hosted playback URL — not compatible with bidirectional stream.
    // Log and skip audio; Gather fallback handles production TTS if triggered.
  }

  private sendMulawToTwilio(state: MediaStreamSessionState, mulawBase64: string): void {
    if (state.twilioWs.readyState !== state.twilioWs.OPEN) return;
    state.twilioWs.send(buildTwilioMediaPayload(state.streamSid, mulawBase64));
    this.events.emit('stream.chunk', {
      callSessionId: state.callSessionId,
      text: '[audio]',
    });
  }

  private async cancelTts(callSessionId: string, reason: string): Promise<void> {
    const state = this.sessions.get(callSessionId);
    if (!state) return;

    state.ttsAbort?.abort();
    state.ttsAbort = null;
    state.speaking = false;

    if (state.twilioWs.readyState === state.twilioWs.OPEN && state.streamSid) {
      state.twilioWs.send(buildTwilioClearPayload(state.streamSid));
    }

    this.logger.debug(JSON.stringify({ event: 'realtime.media_stream.tts_cancelled', callSessionId, reason }));
    await this.metrics.record(callSessionId, { streamingStatus: 'interrupted', agentSpeaking: false });
  }

  private async triggerFallback(callSessionId: string, callSid: string, reason: string): Promise<void> {
    void this.e2eTrace.record(callSessionId, 'fallback_triggered', {
      ok: false,
      provider: 'twilio_gather',
      error: reason,
    });
    await this.metrics.recordFallback(callSessionId, reason);
    await this.teardown(callSessionId);
    await this.fallback.redirectToGather(callSessionId, callSid, reason);
  }

  private async teardown(callSessionId: string): Promise<void> {
    const state = this.sessions.get(callSessionId);
    if (!state) return;

    state.ttsAbort?.abort();
    state.openaiBridge?.close();
    this.sessions.delete(callSessionId);
  }
}
