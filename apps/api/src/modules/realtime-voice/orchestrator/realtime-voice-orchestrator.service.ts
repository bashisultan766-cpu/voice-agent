import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionContextService } from '../../calls/runtime/session-context.service';
import { RouterAgent } from '../agents/router.agent';
import { ConversationAgent } from '../agents/conversation.agent';
import { ShopifySearchAgent } from '../agents/shopify-search.agent';
import { IsbnSearchAgent } from '../agents/isbn-search.agent';
import { EmailVerificationAgent } from '../agents/email-verification.agent';
import { PaymentLinkAgent } from '../agents/payment-link.agent';
import { MemoryAgent } from '../agents/memory.agent';
import { VoiceStreamingAgent } from '../agents/voice-streaming.agent';
import { BackgroundTaskAgent } from '../agents/background-task.agent';
import { AnalyticsAgent } from '../agents/analytics.agent';
import { VoiceEventBusService } from '../events/voice-event-bus.service';
import { buildVoiceOrchestrationGraph } from '../graph/voice-orchestration.graph';
import { VoiceCheckoutFlowService } from '../checkout/voice-checkout-flow.service';
import { emptyCheckoutSession } from '../checkout/voice-checkout-session.types';
import { checkoutStageFiller, isResendPaymentEmailRequest } from '../checkout/voice-checkout-flow.util';
import { VoiceE2ETraceService } from '../observability/voice-e2e-trace.service';
import type { AgentTaskResult, VoiceGraphState, VoiceTurnInput, VoiceTurnOutput } from '../types/voice-turn.types';

const PARALLEL_TIMEOUT_MS = 2500;

@Injectable()
export class RealtimeVoiceOrchestratorService {
  private readonly logger = new Logger(RealtimeVoiceOrchestratorService.name);
  private readonly enabled: boolean;
  private readonly graph;

  constructor(
    private readonly config: ConfigService,
    private readonly sessionContext: SessionContextService,
    private readonly router: RouterAgent,
    private readonly conversation: ConversationAgent,
    private readonly shopifySearch: ShopifySearchAgent,
    private readonly isbnSearch: IsbnSearchAgent,
    private readonly emailVerification: EmailVerificationAgent,
    private readonly paymentLink: PaymentLinkAgent,
    private readonly memory: MemoryAgent,
    private readonly voiceStreaming: VoiceStreamingAgent,
    private readonly backgroundTasks: BackgroundTaskAgent,
    private readonly analytics: AnalyticsAgent,
    private readonly events: VoiceEventBusService,
    private readonly checkoutFlow: VoiceCheckoutFlowService,
    private readonly e2eTrace: VoiceE2ETraceService,
  ) {
    this.enabled = this.config.get<string>('REALTIME_MULTI_AGENT_ENABLED') === 'true';
    this.graph = buildVoiceOrchestrationGraph({
      router: (s) => this.router.route(s),
      conversationFiller: (s) => Promise.resolve(this.conversation.immediateFiller(s)),
      parallelAgents: (s) => this.runParallelAgents(s),
      synthesize: (s) => Promise.resolve(this.conversation.synthesize(s)),
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async processTurn(input: VoiceTurnInput): Promise<VoiceTurnOutput> {
    const started = Date.now();
    this.events.emit('turn.received', {
      callSessionId: input.callSessionId,
      tenantId: input.context.tenantId,
      agentId: input.context.agentId,
      text: input.utterance.slice(0, 200),
    });

    let checkoutSession = await this.checkoutFlow.loadSession(input.callSessionId);
    checkoutSession = await this.checkoutFlow.refreshPaymentStatus(checkoutSession);

    if (!this.e2eTrace.resolveTraceId(input.callSessionId)) {
      this.e2eTrace.startTrace(input.callSessionId, 'synthetic');
    }

    const initialState: VoiceGraphState = {
      callSessionId: input.callSessionId,
      utterance: input.utterance,
      history: input.history,
      context: input.context,
      intent: 'unknown',
      intentConfidence: 0,
      immediateFiller: '',
      agentResults: [],
      reply: '',
      modelUsed: 'gpt-4o-mini',
      escalateToComplexModel: false,
      memoryPatch: {},
      checkoutSession,
    };

    const finalState = (await this.graph.invoke(initialState)) as VoiceGraphState;

    void this.memory.persist(finalState);
    void this.backgroundTasks.enqueuePostTurnTasks(finalState);
    void this.voiceStreaming.streamReply(finalState);
    const analyticsResult = await this.analytics.recordTurn(
      finalState,
      finalState.agentResults,
      Date.now() - started,
    );
    finalState.agentResults.push(analyticsResult);

    this.events.emit('reply.synthesized', {
      callSessionId: input.callSessionId,
      text: finalState.reply.slice(0, 300),
      latencyMs: Date.now() - started,
    });

    return {
      reply: finalState.reply,
      immediateFiller: finalState.immediateFiller || undefined,
      intent: finalState.intent,
      needsDeferredPoll:
        Boolean(finalState.immediateFiller) &&
        (finalState.intent === 'product_search' || finalState.intent === 'isbn_search'),
      agentResults: finalState.agentResults,
      modelUsed: finalState.modelUsed,
      totalLatencyMs: Date.now() - started,
      turnProof: {
        architecture: 'multi_agent_langgraph_v1',
        intent: finalState.intent,
        intentConfidence: finalState.intentConfidence,
        checkoutStage: finalState.checkoutSession.stage,
        agents: finalState.agentResults,
      },
    };
  }

  async processUtterance(
    callSessionId: string,
    utterance: string,
    history: VoiceTurnInput['history'] = [],
  ): Promise<VoiceTurnOutput> {
    const context = await this.sessionContext.load(callSessionId);
    if (!context) {
      return {
        reply: "I'm sorry, I couldn't load your call session. Please try again.",
        intent: 'unknown',
        agentResults: [],
        modelUsed: 'none',
        totalLatencyMs: 0,
        turnProof: { error: 'session_missing' },
      };
    }
    return this.processTurn({ callSessionId, utterance, history, context });
  }

  private async runParallelAgents(state: VoiceGraphState): Promise<Partial<VoiceGraphState>> {
    const tasks: Array<Promise<AgentTaskResult>> = [this.memory.hydrate(state)];

    const session = state.checkoutSession ?? emptyCheckoutSession();
    const needsEmail =
      state.intent === 'email_capture' ||
      session.stage === 'awaiting_email' ||
      session.stage === 'email_confirmation';
    const needsPayment =
      state.intent === 'checkout' ||
      this.checkoutFlow.shouldRunPaymentLink(state, session) ||
      isResendPaymentEmailRequest(state.utterance);

    switch (state.intent) {
      case 'product_search':
        tasks.push(this.shopifySearch.search(state));
        break;
      case 'isbn_search':
        tasks.push(this.isbnSearch.search(state));
        tasks.push(this.shopifySearch.search(state));
        break;
      default:
        break;
    }

    if (needsEmail) {
      tasks.push(this.emailVerification.verify(state));
    }
    if (needsPayment) {
      tasks.push(this.paymentLink.createLink(state));
    }

    const results = await this.raceAllWithTimeout(tasks, PARALLEL_TIMEOUT_MS);
    for (const r of results) {
      this.events.emit(r.ok ? 'agent.completed' : 'agent.failed', {
        callSessionId: state.callSessionId,
        agent: r.agent,
        result: r,
      });
    }

    state.agentResults = results;

    let checkoutSession = this.checkoutFlow.applyTurn(state, session);
    checkoutSession = await this.checkoutFlow.refreshPaymentStatus(checkoutSession);

    const memoryPatch = {
      ...state.memoryPatch,
      ...this.checkoutFlow.checkoutMemoryPatch(checkoutSession),
    };

    const emailResult = results.find((r) => r.agent === 'email_verification');
    if (emailResult?.ok && emailResult.data) {
      const normalized = (emailResult.data as { normalized?: string }).normalized;
      if (normalized) memoryPatch.customerEmail = normalized;
    }
    if (checkoutSession.confirmedEmail) {
      memoryPatch.customerEmail = checkoutSession.confirmedEmail;
    }

    const slowTool = results.some((r) => r.error === 'agent_timeout' || r.error === 'checkout_timeout');
    const stageFiller = checkoutStageFiller(checkoutSession.stage, slowTool);
    const immediateFiller =
      slowTool || needsPayment || needsEmail
        ? stageFiller || state.immediateFiller
        : state.immediateFiller;

    await this.checkoutFlow.saveSession(state.callSessionId, checkoutSession);

    this.events.emit('intent.routed', {
      callSessionId: state.callSessionId,
      intent: state.intent,
    });

    return {
      agentResults: results,
      checkoutSession,
      memoryPatch,
      immediateFiller,
    };
  }

  private async raceAllWithTimeout(
    tasks: Array<Promise<AgentTaskResult>>,
    timeoutMs: number,
  ): Promise<AgentTaskResult[]> {
    return Promise.all(
      tasks.map(async (task) => {
        try {
          return await Promise.race([
            task,
            new Promise<AgentTaskResult>((_, reject) =>
              setTimeout(() => reject(new Error('agent_timeout')), timeoutMs),
            ),
          ]);
        } catch (err) {
          return {
            agent: 'unknown',
            ok: false,
            error: (err as Error).message,
            latencyMs: timeoutMs,
          };
        }
      }),
    );
  }
}
