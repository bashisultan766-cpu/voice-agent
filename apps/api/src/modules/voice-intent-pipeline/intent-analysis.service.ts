import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { SessionContextService } from '../calls/runtime/session-context.service';
import { classifySureShotVoiceIntent } from '../voice/utils/normalize-voice-intent.util';
import { classifyUserIntent } from '../calls/runtime/user-intent-classifier.util';
import {
  buildIntentAnalysisUserPrompt,
  INTENT_ANALYSIS_SYSTEM_PROMPT,
} from './prompts/intent-analysis.prompt';
import type {
  IntentAction,
  IntentAnalysisResult,
  IntentEmotion,
  IntentEntities,
  IntentRiskLevel,
  IntentUrgency,
} from './types/intent-analysis.types';
import type { RawVoiceSession } from './types/raw-session.types';
import { normalizeOpenAiChatCompletionsModel } from '../integrations/openai/voice-tool-schema.util';
import { VoiceResponseCacheService } from './voice-response-cache.service';

const VALID_ACTIONS = new Set<IntentAction>([
  'order_lookup',
  'refund',
  'cancel',
  'shipping_check',
  'payment_link',
  'product_search',
  'escalate',
  'general',
]);

const ORDER_ID_RE = /\b(?:order\s*(?:#|number|no\.?)?\s*)?(\d{3,8})\b/gi;

function extractOrderIds(text: string): string[] {
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(ORDER_ID_RE.source, ORDER_ID_RE.flags);
  while ((m = re.exec(text)) !== null) {
    if (m[1]) ids.add(m[1]);
  }
  return [...ids];
}

function emptyEntities(customerRequest: string): IntentEntities {
  return {
    order_id: null,
    order_ids: [],
    products: [],
    quantity: null,
    customer_request: customerRequest,
  };
}

function parseEmotion(raw: unknown): IntentEmotion {
  if (raw === 'angry' || raw === 'frustrated' || raw === 'happy') return raw;
  return 'neutral';
}

function parseUrgency(raw: unknown): IntentUrgency {
  if (raw === 'critical' || raw === 'high' || raw === 'medium') return raw;
  return 'low';
}

function parseIntentJson(raw: string, fullMessage: string): IntentAnalysisResult | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entitiesRaw = (parsed.entities ?? {}) as Record<string, unknown>;
    const orderIds = Array.isArray(entitiesRaw.order_ids)
      ? entitiesRaw.order_ids.map(String).filter(Boolean)
      : extractOrderIds(fullMessage);
    const entities: IntentEntities = {
      order_id:
        typeof entitiesRaw.order_id === 'string' && entitiesRaw.order_id.trim()
          ? entitiesRaw.order_id.trim()
          : orderIds[0] ?? null,
      order_ids: orderIds,
      products: Array.isArray(entitiesRaw.products) ? entitiesRaw.products.map(String) : [],
      quantity:
        typeof entitiesRaw.quantity === 'number' && Number.isFinite(entitiesRaw.quantity)
          ? entitiesRaw.quantity
          : null,
      customer_request:
        typeof entitiesRaw.customer_request === 'string' && entitiesRaw.customer_request.trim()
          ? entitiesRaw.customer_request.trim()
          : fullMessage,
    };
    const actionsRaw = Array.isArray(parsed.actions) ? parsed.actions.map(String) : [];
    const actions = actionsRaw.filter((a): a is IntentAction =>
      VALID_ACTIONS.has(a as IntentAction),
    );
    const risk = parsed.risk_level;
    const risk_level: IntentRiskLevel =
      risk === 'high' || risk === 'medium' || risk === 'low' ? risk : 'low';
    const secondary_intents = Array.isArray(parsed.secondary_intents)
      ? parsed.secondary_intents.map(String).filter(Boolean)
      : [];
    const primary =
      typeof parsed.primary_intent === 'string' && parsed.primary_intent.trim()
        ? parsed.primary_intent.trim()
        : typeof parsed.intent === 'string' && parsed.intent.trim()
          ? parsed.intent.trim()
          : 'general_inquiry';
    const multi_intent =
      parsed.multi_intent === true ||
      actions.length > 1 ||
      secondary_intents.length > 0;

    return {
      intent: primary,
      primary_intent: primary,
      secondary_intents,
      multi_intent,
      entities,
      actions: actions.length > 0 ? actions : ['general'],
      risk_level,
      emotion: parseEmotion(parsed.emotion),
      urgency: parseUrgency(parsed.urgency),
      refund_risk: parsed.refund_risk === true,
      source: 'openai',
    };
  } catch {
    return null;
  }
}

@Injectable()
export class IntentAnalysisService {
  private readonly logger = new Logger(IntentAnalysisService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sessionContext: SessionContextService,
    private readonly responseCache: VoiceResponseCacheService,
  ) {}

  isEnabled(): boolean {
    const raw = (this.config.get<string>('VOICE_INTENT_PIPELINE_ENABLED') ?? 'true')
      .trim()
      .toLowerCase();
    return raw !== 'false' && raw !== '0';
  }

  async analyze(args: {
    callSessionId: string;
    rawSession: RawVoiceSession;
  }): Promise<IntentAnalysisResult> {
    const started = Date.now();
    const fullMessage = args.rawSession.latestUserMessage;
    if (!fullMessage.trim()) {
      return this.rulesFallback(fullMessage, started);
    }

    const cached = await this.responseCache.getIntent(fullMessage);
    if (cached) {
      this.logger.debug(
        JSON.stringify({
          event: 'voice.intent.cache_hit',
          callSessionId: args.callSessionId,
        }),
      );
      return cached;
    }

    if (!this.isEnabled()) {
      return this.rulesFallback(fullMessage, started);
    }

    const ctx = await this.sessionContext.load(args.callSessionId);
    const apiKey =
      ctx?.agent.openaiApiKey?.trim() || this.config.get<string>('OPENAI_API_KEY')?.trim() || '';
    if (!apiKey) {
      return this.rulesFallback(fullMessage, started);
    }

    const model = normalizeOpenAiChatCompletionsModel(
      this.config.get<string>('VOICE_INTENT_MODEL') ??
        this.config.get<string>('OPENAI_REALTIME_MODEL') ??
        'gpt-4o-mini',
    );

    const recentHistory = args.rawSession.turns
      .filter((t) => t.role === 'user' || t.role === 'assistant')
      .slice(-12);

    try {
      const client = new OpenAI({ apiKey });
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.1,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: INTENT_ANALYSIS_SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildIntentAnalysisUserPrompt({
              latestMessage: fullMessage,
              recentHistory,
            }),
          },
        ],
      });

      const content = completion.choices[0]?.message?.content ?? '';
      const parsed = parseIntentJson(content, fullMessage);
      if (parsed) {
        parsed.latencyMs = Date.now() - started;
        await this.responseCache.setIntent(fullMessage, parsed);
        this.logger.log(
          JSON.stringify({
            event: 'voice.intent.analyzed',
            callSessionId: args.callSessionId,
            intent: parsed.intent,
            multi_intent: parsed.multi_intent,
            emotion: parsed.emotion,
            urgency: parsed.urgency,
            refund_risk: parsed.refund_risk,
            actionCount: parsed.actions.length,
            latencyMs: parsed.latencyMs,
            source: 'openai',
          }),
        );
        return parsed;
      }
    } catch (err) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.intent.openai_failed',
          callSessionId: args.callSessionId,
          message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        }),
      );
    }

    const fallback = this.rulesFallback(fullMessage, started);
    await this.responseCache.setIntent(fullMessage, fallback);
    return fallback;
  }

  private rulesFallback(fullMessage: string, started: number): IntentAnalysisResult {
    const sureShot = classifySureShotVoiceIntent(fullMessage);
    const userIntent = classifyUserIntent(fullMessage);
    const orderIds = extractOrderIds(fullMessage);
    const actions: IntentAction[] = [];

    if (sureShot.intent === 'tracking_status' || /\b(shipping|tracking|delivery)\b/i.test(fullMessage)) {
      actions.push('shipping_check');
    }
    if (sureShot.intent === 'order_lookup' || orderIds.length > 0 || /\border\b/i.test(fullMessage)) {
      actions.push('order_lookup');
    }
    if (/\brefund\b/i.test(fullMessage)) actions.push('refund');
    if (/\bcancel/i.test(fullMessage)) actions.push('cancel');
    if (/\b(payment link|checkout|pay)\b/i.test(fullMessage)) actions.push('payment_link');
    if (userIntent === 'product_search' || /\b(book|isbn|title)\b/i.test(fullMessage)) {
      actions.push('product_search');
    }
    if (/\b(human|agent|manager|escalat)\b/i.test(fullMessage)) actions.push('escalate');
    if (actions.length === 0) actions.push('general');

    const uniqueActions = [...new Set(actions)];
    const secondary = uniqueActions.slice(1).map((a) => a.replace(/_/g, ' '));
    const entities = emptyEntities(fullMessage);
    entities.order_id = orderIds[0] ?? null;
    entities.order_ids = orderIds;

    const angry = /\b(angry|furious|lawsuit|lawyer|chargeback|scam|terrible)\b/i.test(fullMessage);
    const frustrated = /\b(frustrated|upset|again|still waiting|unacceptable)\b/i.test(fullMessage);
    const happy = /\b(thank|thanks|great|awesome|perfect)\b/i.test(fullMessage);
    const emotion: IntentEmotion = angry ? 'angry' : frustrated ? 'frustrated' : happy ? 'happy' : 'neutral';
    const urgency: IntentUrgency = angry
      ? 'critical'
      : /\b(urgent|asap|today|immediately)\b/i.test(fullMessage)
        ? 'high'
        : uniqueActions.length > 1
          ? 'medium'
          : 'low';

    const primary =
      sureShot.intent !== 'unknown' ? sureShot.intent : userIntent;

    return {
      intent: primary,
      primary_intent: primary,
      secondary_intents: secondary,
      multi_intent: uniqueActions.length > 1,
      entities,
      actions: uniqueActions,
      risk_level: angry || /\b(chargeback|fraud)\b/i.test(fullMessage) ? 'high' : 'low',
      emotion,
      urgency,
      refund_risk: /\b(refund|chargeback|money back)\b/i.test(fullMessage) && (angry || frustrated),
      source: 'rules_fallback',
      latencyMs: Date.now() - started,
    };
  }
}
