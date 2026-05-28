import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../../database/prisma.service';
import { SessionContextService } from './session-context.service';
import { buildTranscriptNormalizerSystemPrompt } from './transcript-normalizer-prompt.util';
import { normalizeOpenAiChatCompletionsModel } from '../../integrations/openai/voice-tool-schema.util';

const NORMALIZER_MODEL = 'gpt-4o-mini';
const NORMALIZER_TEMPERATURE = 0.1;
const NORMALIZER_MAX_TOKENS = 40;

export type TranscriptNormalizeConfidence = 'high' | 'medium' | 'low' | 'unchanged';

export type TranscriptNormalizeResult = {
  raw: string;
  normalized: string;
  corrected: boolean;
  confidence: TranscriptNormalizeConfidence;
  skipped?: boolean;
  skipReason?: string;
};

export type TranscriptConversationContext = {
  tenantId: string;
  agentId: string;
  callSessionId: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  catalogHints?: string[];
};

export type TranscriptNormalizeCompletionFn = (
  params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
) => Promise<OpenAI.Chat.ChatCompletion>;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function shouldSkipNormalization(text: string): string | null {
  const t = collapseWhitespace(text);
  if (!t) return 'empty';
  if (t.length < 4) return 'too_short';
  if (/^(yes|no|yeah|yep|nope|ok|okay|thanks|thank you|hello|hi|hey|bye|goodbye)\.?$/i.test(t)) {
    return 'trivial_utterance';
  }
  return null;
}

function parseModelCorrection(content: string | null | undefined): string {
  const firstLine = (content ?? '')
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return '';
  return firstLine.replace(/^["'“”]+|["'“”]+$/g, '').trim();
}

function estimateConfidence(raw: string, normalized: string): TranscriptNormalizeConfidence {
  const a = collapseWhitespace(raw).toLowerCase();
  const b = collapseWhitespace(normalized).toLowerCase();
  if (!b || a === b) return 'unchanged';
  const longer = Math.max(a.length, b.length, 1);
  let edits = 0;
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) edits += 1;
  }
  edits += Math.abs(a.length - b.length);
  const ratio = edits / longer;
  if (ratio >= 0.22) return 'high';
  if (ratio >= 0.08) return 'medium';
  return 'low';
}

@Injectable()
export class TranscriptNormalizerService {
  private readonly logger = new Logger(TranscriptNormalizerService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sessionContext: SessionContextService,
    private readonly prisma: PrismaService,
  ) {}

  async normalizeTranscript(
    input: string,
    conversationContext: TranscriptConversationContext,
    options?: { completionFn?: TranscriptNormalizeCompletionFn },
  ): Promise<TranscriptNormalizeResult> {
    const raw = collapseWhitespace(input);
    const skipReason = shouldSkipNormalization(raw);
    if (skipReason) {
      return {
        raw,
        normalized: raw,
        corrected: false,
        confidence: 'unchanged',
        skipped: true,
        skipReason,
      };
    }

    this.logger.log(
      JSON.stringify({
        event: 'voice.transcript.raw',
        callSessionId: conversationContext.callSessionId,
        tenantId: conversationContext.tenantId,
        agentId: conversationContext.agentId,
        text: raw.slice(0, 500),
      }),
    );

    const ctx = await this.sessionContext.load(conversationContext.callSessionId);
    const apiKey =
      ctx?.agent.openaiApiKey?.trim() ||
      this.config.get<string>('OPENAI_API_KEY')?.trim() ||
      '';
    if (!apiKey) {
      return {
        raw,
        normalized: raw,
        corrected: false,
        confidence: 'unchanged',
        skipped: true,
        skipReason: 'openai_key_missing',
      };
    }

    const catalogHints =
      conversationContext.catalogHints ??
      (await this.loadCatalogHints(conversationContext.tenantId, conversationContext.agentId));

    const recentTurns = (conversationContext.conversationHistory ?? [])
      .slice(-4)
      .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
      .join('\n');

    const userPrompt = [
      recentTurns ? `Recent conversation:\n${recentTurns}` : null,
      `Caller transcript to correct:\n${raw}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const client = new OpenAI({ apiKey });
    const complete: TranscriptNormalizeCompletionFn =
      options?.completionFn ?? ((params) => client.chat.completions.create(params));

    try {
      const response = await complete({
        model: normalizeOpenAiChatCompletionsModel(NORMALIZER_MODEL),
        temperature: NORMALIZER_TEMPERATURE,
        max_tokens: NORMALIZER_MAX_TOKENS,
        messages: [
          { role: 'system', content: buildTranscriptNormalizerSystemPrompt(catalogHints) },
          { role: 'user', content: userPrompt },
        ],
      });

      const modelText = parseModelCorrection(response.choices[0]?.message?.content);
      const normalized = collapseWhitespace(modelText) || raw;
      const confidence = estimateConfidence(raw, normalized);
      const corrected = normalized.toLowerCase() !== raw.toLowerCase();

      this.logger.log(
        JSON.stringify({
          event: 'voice.transcript.normalized',
          callSessionId: conversationContext.callSessionId,
          raw: raw.slice(0, 500),
          normalized: normalized.slice(0, 500),
        }),
      );

      if (corrected) {
        this.logger.log(
          JSON.stringify({
            event: 'voice.transcript.corrected',
            callSessionId: conversationContext.callSessionId,
            before: raw.slice(0, 500),
            after: normalized.slice(0, 500),
            confidence,
          }),
        );
      }

      return { raw, normalized, corrected, confidence };
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 200) : 'normalize_failed';
      this.logger.warn(
        JSON.stringify({
          event: 'voice.transcript.normalize_failed',
          callSessionId: conversationContext.callSessionId,
          message,
        }),
      );
      return {
        raw,
        normalized: raw,
        corrected: false,
        confidence: 'unchanged',
        skipped: true,
        skipReason: 'openai_error',
      };
    }
  }

  async loadCatalogHints(tenantId: string, agentId: string): Promise<string[]> {
    const rows = await this.prisma.productCache.findMany({
      where: { tenantId, agentId },
      select: { title: true, vendor: true },
      orderBy: { updatedAt: 'desc' },
      take: 40,
    });
    const hints = new Set<string>();
    for (const row of rows) {
      const title = row.title?.trim();
      if (title && title.length >= 3) hints.add(title);
      const vendor = row.vendor?.trim();
      if (vendor && vendor.length >= 3) hints.add(vendor);
    }
    return [...hints];
  }
}
