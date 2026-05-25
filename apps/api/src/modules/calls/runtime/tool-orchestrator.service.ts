import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { Prisma } from '@prisma/client';
import { OpenAIToolRegistryService } from '../../integrations/openai/openai-tool-registry.service';
import { RetrievalService } from '../../knowledge/retrieval.service';
import { RetrievalOrchestratorService } from '../../knowledge/retrieval-orchestrator.service';
import { CallMemoryService } from './call-memory.service';
import { CallEventsService } from '../../analytics/call-events.service';
import { ShopifyAgentService } from '../../agents/shopify-agent.service';
import {
  PRODUCT_SEARCH_CONFIDENT_MIN_SCORE,
  PRODUCT_SEARCH_CONFIRM_MIN_SCORE,
} from '../../agents/shopify-product-relevance.util';
import { OrderBookingService } from '../../agents/order-booking.service';
import { VoiceSessionContext } from './session-context.service';
import {
  CheckoutLinkStatus,
  ToolExecutionStatus,
  KnowledgeDocType,
  CallEventType,
} from '@prisma/client';
import { CallbackRequestsService } from '../callback-requests.service';
import { ShopifyCheckoutService } from '../../integrations/shopify/shopify-checkout.service';
import { TwilioSmsService } from '../../integrations/twilio/twilio-sms.service';
import { AgentsService } from '../../agents/agents.service';
import { ShopifyProductSearchService } from '../../integrations/shopify/product-search';
import { ResendEmailService } from '../../integrations/email/resend-email.service';
import { AgentEmailConfigService } from '../../integrations/email/agent-email-config.service';
import { paymentEmailIdempotencyKey } from '../../../common/payment-email-idempotency';
import { TranscriptBufferService } from './transcript-buffer.service';
import { parseVoiceToolArgs } from '../../integrations/openai/voice-tool-args';
import { toCheckoutModeApi } from '@bookstore-voice-agents/types';
import { normalizeShopifyDomain } from '@bookstore-voice-agents/types';
import { variantIdLookupKeys } from '../../integrations/shopify/shopify-ids';
import type { ShopifyProductSummary } from '../../agents/shopify-agent.service';
import { isEmailRequiredBeforeCheckout } from './checkout-email-policy.util';
import { detectLanguageFromText } from './language-intelligence.util';
import { OrderState, canAdvanceOrderState, normalizeOrderState } from './order-state-machine.util';
import {
  formatShopifyErrorForCaller,
  ShopifyCheckoutValidationError,
  ShopifyGraphqlError,
} from '../../integrations/shopify/shopify-errors';

const MAX_TOOL_CALLS_PER_CALL = Number(process.env.MAX_TOOL_CALLS_PER_CALL) || 12;

export interface ToolResult {
  ok: boolean;
  toolName: string;
  storeId: string | null;
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean };
  meta?: { source: string; latencyMs?: number };
}

@Injectable()
export class ToolOrchestratorService {
  private readonly logger = new Logger(ToolOrchestratorService.name);
  private static readonly ORDER_STATE_SEQUENCE: OrderState[] = [
    'IDLE',
    'PRODUCT_DISCOVERY',
    'EMAIL_COLLECTION',
    'DONE',
  ];

  private static readonly SENSITIVE_PAYMENT_KEYS = [
    'card',
    'cardNumber',
    'card_number',
    'cvv',
    'cvc',
    'expiry',
    'exp',
    'securityCode',
    'security_code',
    'iban',
    'bankAccount',
    'bank_account',
  ];
  private static readonly SENSITIVE_PAYMENT_PATTERN =
    /\b(?:\d[ -]*?){13,19}\b|\b(?:cvv|cvc|security code|card number|expiry|exp)\b/i;

  constructor(
    private readonly prisma: PrismaService,
    private readonly toolRegistry: OpenAIToolRegistryService,
    private readonly retrieval: RetrievalService,
    private readonly retrievalOrchestrator: RetrievalOrchestratorService,
    private readonly callMemory: CallMemoryService,
    private readonly callEvents: CallEventsService,
    private readonly shopifyAgent: ShopifyAgentService,
    private readonly callbacks: CallbackRequestsService,
    private readonly booking: OrderBookingService,
    private readonly checkout: ShopifyCheckoutService,
    private readonly twilioSms: TwilioSmsService,
    private readonly agentsService: AgentsService,
    private readonly productSearch: ShopifyProductSearchService,
    private readonly resendEmail: ResendEmailService,
    private readonly agentEmailConfig: AgentEmailConfigService,
    private readonly transcriptBuffer: TranscriptBufferService,
  ) {}

  private mapLiveSummaryToDetailsProduct(
    live: ShopifyProductSummary,
    preferredVariantId?: string,
  ): NonNullable<Awaited<ReturnType<ShopifyProductSearchService['getDetails']>>> {
    const keys = preferredVariantId?.trim() ? variantIdLookupKeys(preferredVariantId) : [];
    let selectedVariantId: string | null = null;
    const variants = live.variants.map((v) => ({
      variantId: v.id,
      title: v.title,
      sku: v.sku ?? null,
      isbn: v.isbn ?? null,
      price: v.price ?? null,
      compareAtPrice: null as string | null,
      inventoryQuantity: v.inventory_quantity,
      availableForSale: v.availableForSale !== false,
    }));
    if (keys.length) {
      const hit = live.variants.find((v) => keys.includes(v.id));
      if (hit) selectedVariantId = hit.id;
    }
    const ordered =
      selectedVariantId != null
        ? [
            variants.find((x) => x.variantId === selectedVariantId)!,
            ...variants.filter((x) => x.variantId !== selectedVariantId),
          ]
        : variants;
    return {
      productId: live.productId,
      title: live.title,
      handle: live.handle ?? null,
      vendor: null,
      productType: null,
      status: live.status,
      tags: null,
      isbn: live.isbn ?? null,
      selectedVariantId,
      variants: ordered,
      syncedAt: new Date(),
    };
  }

  private getStringArg(input: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  private getBooleanArg(input: Record<string, unknown>, ...keys: string[]): boolean | null {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        if (value.toLowerCase() === 'true') return true;
        if (value.toLowerCase() === 'false') return false;
      }
    }
    return null;
  }

  private normalizeProductQueryText(text: string): string {
    const cleaned = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .replace(/\b(i want|i need|please|show me|looking for|can you|do you have)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned;
  }

  private hasSpecificProductSignal(query: string): boolean {
    const t = query.trim().toLowerCase();
    if (!t) return false;
    if (
      /\b(i need a book|need a book|want a book|any book|some book|book please|find me a book)\b/i.test(
        t,
      )
    ) {
      return false;
    }
    if (/\b(?:97[89][-\s]?)?\d{9}[\dx]\b/i.test(t)) return true; // ISBN-10/13
    if (/\bsku[:\s-]*[a-z0-9_-]{3,}\b/i.test(t)) return true;
    if (/\b(atomic habits|dune|game of thrones)\b/i.test(t)) return true;
    if (/\b(do you have|check|find|search)\b\s+.{2,}/i.test(t)) return true;
    if (t.split(/\s+/).length >= 2 && !/\b(sports|electronics|clothes|products|store)\b/i.test(t)) {
      return true;
    }
    return false;
  }

  private getSearchToolPolicy(
    lastUserIntent: string | null,
    query: string,
  ): { allowed: boolean; reason: string | null } {
    const intent = (lastUserIntent ?? '').trim().toLowerCase();
    const blockedIntents = new Set([
      'greeting',
      'small_talk',
      'store_identity_question',
      'store_category_question',
      'capability_question',
      'general_business_question',
      'unclear',
      'unknown',
    ]);
    if (blockedIntents.has(intent)) {
      if (intent === 'store_category_question') {
        return { allowed: false, reason: 'general_category_question' };
      }
      return { allowed: false, reason: `intent_${intent || 'unknown'}_blocked` };
    }
    if (!this.hasSpecificProductSignal(query)) {
      return { allowed: false, reason: 'query_not_specific_enough' };
    }
    return { allowed: true, reason: null };
  }

  private maskEmailForLog(email: string): string {
    const t = email.trim().toLowerCase();
    const at = t.indexOf('@');
    if (at < 1) return '***';
    return `${t[0]}***${t.slice(at)}`;
  }

  private normalizeItems(raw: unknown): Array<{ productId: string; variantId?: string; title?: string; quantity: number }> {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const row = item as Record<string, unknown>;
        const productId = this.getStringArg(row, 'productId', 'product_id');
        const variantId = this.getStringArg(row, 'variantId', 'variant_id');
        const title = this.getStringArg(row, 'title');
        const quantityRaw = row.quantity;
        const quantity = typeof quantityRaw === 'number' ? quantityRaw : Number(quantityRaw ?? 1);
        if (!productId && !variantId && !title) return null;
        return {
          productId: productId || variantId || title,
          variantId: variantId || undefined,
          title: title || undefined,
          quantity: Math.max(1, Number.isFinite(quantity) ? Math.trunc(quantity) : 1),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private async getSessionMetadata(callSessionId: string): Promise<Record<string, unknown>> {
    const session = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      select: { metadata: true },
    });
    if (!session?.metadata || typeof session.metadata !== 'object' || Array.isArray(session.metadata)) return {};
    return session.metadata as Record<string, unknown>;
  }

  private async updateOrderStateMetadata(
    callSessionId: string,
    patch: Partial<{
      orderState: OrderState;
      language: string;
      languageConfidence: number;
      normalizedEmail: string;
      emailRetryCount: number;
      productMatchConfidence: number;
      productMatchName: string;
      paymentLink: string;
      quantity: number;
      customerName: string;
    }>,
  ): Promise<void> {
    const metadata = await this.getSessionMetadata(callSessionId);
    const currentState = normalizeOrderState(metadata.orderState);
    const requestedState = patch.orderState ?? currentState;
    const safeState = canAdvanceOrderState(currentState, requestedState) ? requestedState : currentState;
    const merged: Record<string, unknown> = {
      ...metadata,
      ...patch,
      orderState: safeState,
    };
    await this.prisma.callSession.update({
      where: { id: callSessionId },
      data: { metadata: merged as Prisma.InputJsonValue },
    });
  }

  private hasSensitivePaymentInput(args: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(args)) {
      if (ToolOrchestratorService.SENSITIVE_PAYMENT_KEYS.includes(key)) return true;
      if (typeof value === 'string' && ToolOrchestratorService.SENSITIVE_PAYMENT_PATTERN.test(value)) return true;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && ToolOrchestratorService.SENSITIVE_PAYMENT_PATTERN.test(item)) return true;
        }
      }
      if (value && typeof value === 'object') {
        const nested = value as Record<string, unknown>;
        for (const nestedValue of Object.values(nested)) {
          if (typeof nestedValue === 'string' && ToolOrchestratorService.SENSITIVE_PAYMENT_PATTERN.test(nestedValue)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Execute one tool call. Injects tenantId, storeId from context.
   * Logs to ToolExecution. Returns normalized result for model.
   */
  async execute(
    ctx: VoiceSessionContext,
    toolName: string,
    args: Record<string, unknown>,
    callSessionId: string,
    requestId?: string,
  ): Promise<ToolResult> {
    const summaryInput = JSON.stringify(args ?? {}).slice(0, 400);
    const startSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
    await this.transcriptBuffer.append(
      callSessionId,
      'tool',
      `Tool call started: ${toolName}(${summaryInput})`,
      startSeq,
    );
    const start = Date.now();
    this.logger.log(
      JSON.stringify({
        event: 'voice.tool.execute_start',
        callSessionId,
        toolName,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
      }),
    );
    const allowed = this.toolRegistry.isToolAllowed(toolName, {
      enabledTools: ctx.agent.enabledTools,
      toolPermissions: ctx.agent.toolPermissions,
    });
    if (!allowed) {
      const blocked = await this.logAndReturn(ctx, callSessionId, toolName, args, requestId, start, {
        ok: false,
        error: { code: 'TOOL_NOT_ALLOWED', message: 'Tool not enabled for this agent', retryable: false },
        data: {
          voiceSummary:
            'That action is not available on this line right now. I can still answer from our catalog with a quick search, or we can arrange a callback.',
        },
      });
      const blockedSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
      await this.transcriptBuffer.append(
        callSessionId,
        'tool',
        `Tool call blocked: ${toolName} (${blocked.error?.message ?? 'not allowed'})`,
        blockedSeq,
      );
      return blocked;
    }

    if (toolName === 'searchProducts') {
      const metadata = await this.getSessionMetadata(callSessionId);
      const lastUserIntent =
        typeof metadata.lastUserIntent === 'string' ? metadata.lastUserIntent : null;
      const query = this.getStringArg(args, 'query');
      const policy = this.getSearchToolPolicy(lastUserIntent, query);
      if (!policy.allowed) {
        const blocked = await this.logAndReturn(ctx, callSessionId, toolName, args, requestId, start, {
          ok: false,
          error: {
            code: 'TOOL_BLOCKED_BY_INTENT',
            message: `Search blocked by policy: ${policy.reason ?? 'unspecified'}`,
            retryable: false,
          },
          data: {
            voiceSummary:
              "Sure, tell me the book title first and I'll check it for you.",
            toolCallBlockedReason: policy.reason,
            toolCallAllowed: false,
          },
        });
        return blocked;
      }
    }

    const handoffTools = new Set(['escalateToHuman', 'handoff_to_human', 'create_callback_request']);
    if (handoffTools.has(toolName)) {
      const transfersOk = ctx.agent.handoffEnabled !== false && ctx.agent.transferToHumanEnabled !== false;
      if (!transfersOk) {
        return await this.logAndReturn(ctx, callSessionId, toolName, args, requestId, start, {
          ok: false,
          error: { code: 'HANDOFF_DISABLED', message: 'Human transfer disabled for this agent', retryable: false },
          data: {
            voiceSummary:
              'I am not able to transfer this call from here, but I can take your details and have the right person follow up, or answer what I can from our store information.',
          },
        });
      }
    }

    const parsedArgs = parseVoiceToolArgs(toolName, args);
    if (!parsedArgs.ok) {
      return await this.logAndReturn(ctx, callSessionId, toolName, args, requestId, start, {
        ok: false,
        error: {
          code: 'INVALID_ARGS',
          message: parsedArgs.message,
          retryable: false,
        },
        data: {
          voiceSummary: `I could not run that step—the ${parsedArgs.field ? `${parsedArgs.field.replace(/_/g, ' ')} was` : 'information was'} not quite right. Let me ask for that again, or I can connect you with the team.`,
        },
      });
    }
    if (this.hasSensitivePaymentInput(parsedArgs.args)) {
      return await this.logAndReturn(ctx, callSessionId, toolName, args, requestId, start, {
        ok: false,
        error: {
          code: 'PCI_RESTRICTED',
          message: 'Sensitive payment details are not allowed in tool arguments.',
          retryable: false,
        },
        data: {
          voiceSummary:
            'For security, I cannot process or store card details here. I can send a secure Shopify checkout link by SMS or email instead.',
        },
      });
    }

    const fullInput = { ...parsedArgs.args, storeId: ctx.storeId, tenantId: ctx.tenantId };
    try {
      const result = await this.runTool(ctx, toolName, fullInput, callSessionId);
      const logged = await this.logAndReturn(ctx, callSessionId, toolName, fullInput, requestId, start, result);
      await this.callMemory.recordToolCall(callSessionId, toolName, logged.ok);
      const okSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
      await this.transcriptBuffer.append(
        callSessionId,
        'tool',
        `Tool call completed: ${toolName} (${logged.ok ? 'success' : 'failed'})`,
        okSeq,
      );
      return logged;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tool execution failed';
      this.logger.error(
        JSON.stringify({
          event: 'voice.tool.execute_error',
          callSessionId,
          toolName,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          message: message.slice(0, 300),
        }),
      );
      const failed = await this.logAndReturn(ctx, callSessionId, toolName, fullInput, requestId, start, {
        ok: false,
        error: { code: 'TOOL_ERROR', message, retryable: true },
        data: {
          voiceSummary:
            'I hit a temporary issue while checking that. I can try again, suggest an alternative, or connect you to support.',
        },
      });
      const failSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
      await this.transcriptBuffer.append(
        callSessionId,
        'tool',
        `Tool call failed: ${toolName} (${message.slice(0, 240)})`,
        failSeq,
      );
      return failed;
    }
  }

  private async runTool(
    ctx: VoiceSessionContext,
    toolName: string,
    input: Record<string, unknown>,
    callSessionId: string,
  ): Promise<Omit<ToolResult, 'toolName' | 'storeId'>> {
    const noStore = (msg: string) => ({ ok: true, data: { items: [], voiceSummary: msg }, meta: { source: 'system' } as const });
    const storeDependent = [
      'get_store_locations',
      'get_store_hours',
      'search_store_faqs',
      'retrieve_knowledge_base',
      'get_shipping_policy',
      'get_return_policy',
      'get_promotion_details',
      'estimate_shipping',
      'get_store_policy',
      'lookup_discount',
    ];
    if (!ctx.storeId && storeDependent.includes(toolName)) {
      return noStore('Store information is not set up for this agent.');
    }

    switch (toolName) {
      case 'normalizeProductQuery': {
        const text = this.getStringArg(input, 'text');
        if (!text) {
          return {
            ok: false,
            error: { code: 'MISSING_INPUT', message: 'Need text to normalize product query.', retryable: true },
          };
        }
        const normalized = this.normalizeProductQueryText(text);
        return {
          ok: true,
          data: {
            normalizedQuery: normalized || text.trim(),
            voiceSummary: `I normalized that to: ${normalized || text.trim()}`,
          },
          meta: { source: 'system' },
        };
      }
      case 'detectLanguage': {
        const text = this.getStringArg(input, 'text');
        if (!text) {
          return {
            ok: false,
            error: { code: 'MISSING_INPUT', message: 'Need text to detect language.', retryable: true },
          };
        }
        const detected = detectLanguageFromText(text);
        const language = detected.confidence < 0.55 ? 'en' : detected.language;
        await this.updateOrderStateMetadata(callSessionId, {
          language,
          languageConfidence: detected.confidence,
        });
        return {
          ok: true,
          data: {
            language,
            confidence: detected.confidence,
            voiceSummary: `Detected language appears to be ${language}.`,
          },
          meta: { source: 'deterministic_language_detector' },
        };
      }
      case 'validateEmail': {
        const email = this.normalizeEmail(this.getStringArg(input, 'email'));
        const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        const metadata = await this.getSessionMetadata(callSessionId);
        const currentState = normalizeOrderState(metadata.orderState);
        if (ToolOrchestratorService.ORDER_STATE_SEQUENCE.indexOf(currentState) < ToolOrchestratorService.ORDER_STATE_SEQUENCE.indexOf('PRODUCT_DISCOVERY')) {
          await this.updateOrderStateMetadata(callSessionId, {
            orderState: currentState,
          });
          return {
            ok: true,
            data: {
              valid: false,
              normalizedEmail: null,
              retryCount: Number(metadata.emailRetryCount ?? 0),
              voiceSummary: 'Which book are we buying—title or ISBN?',
            },
            meta: { source: 'system' },
          };
        }
        const retries = Number(metadata.emailRetryCount ?? 0);
        const nextRetries = isValid ? retries : retries + 1;
        await this.updateOrderStateMetadata(callSessionId, {
          normalizedEmail: isValid ? email : '',
          emailRetryCount: nextRetries,
          orderState: 'EMAIL_COLLECTION',
        });
        return {
          ok: true,
          data: {
            valid: isValid,
            normalizedEmail: isValid ? email : null,
            retryCount: nextRetries,
            voiceSummary: isValid
              ? `Thanks, I have a valid email: ${email}.`
              : nextRetries >= 2
                ? 'That email still looks invalid. Please say it clearly one final time so I can send your payment link.'
                : 'That email format does not look valid. Please spell it again slowly.',
          },
          meta: { source: 'system' },
        };
      }
      case 'searchProducts': {
        const query = this.getStringArg(input, 'query');
        if (!query) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need query before searching products.', retryable: true } };
        }
        const limit = 1;
        const live = await this.shopifyAgent.searchProducts(ctx.tenantId, ctx.agentId, query, limit);
        if (!live.ok) {
          return {
            ok: false,
            error: {
              code: 'SHOPIFY_SEARCH_FAILED',
              message: live.error ?? 'Shopify product search failed.',
              retryable: true,
            },
            data: {
              voiceSummary: 'I could not search the store catalog right now. Please try again in a moment.',
            },
          };
        }
        const items = live.products ?? [];
        const slog = live.searchVoiceLog;
        const topScore = items[0]?.relevanceScore ?? slog?.topScore ?? 0;
        let confidence = 0;
        if (items.length === 0) confidence = 0;
        else if (topScore >= PRODUCT_SEARCH_CONFIDENT_MIN_SCORE) confidence = 0.95;
        else if (topScore >= PRODUCT_SEARCH_CONFIRM_MIN_SCORE) confidence = 0.78;

        this.logger.log(
          JSON.stringify({
            event: 'voice.tool.search_products',
            eventJourney: 'voice.journey.product_search',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            query,
            productsFound: items.length,
            source: 'shopify_live',
            productSearchInputRaw: slog?.productSearchInputRaw ?? slog?.queryOriginal,
            probableTitle: slog?.probableTitle,
            shopifyQueriesTried: slog?.shopifyQueriesTried,
            productsReturned: slog?.productsReturned ?? slog?.productsReturnedCount ?? slog?.productsReturnedByShopify,
            productsReturnedCount: slog?.productsReturnedCount ?? slog?.productsReturnedByShopify,
            productsAfterRanking: slog?.productsAfterRanking,
            rankedProducts: slog?.rankedProducts,
            topProduct: slog?.topProduct ?? slog?.topProductTitle,
            topProductTitle: slog?.topProductTitle,
            topScore: slog?.topScore ?? slog?.topRelevanceScore,
            topMatchReason: slog?.topMatchReason ?? slog?.matchReason,
            lowConfidenceSearch: slog?.lowConfidenceSearch ?? items.length === 0,
            finalVoiceSummary: slog?.finalVoiceSummary,
          }),
        );
        await this.updateOrderStateMetadata(callSessionId, {
          orderState: 'PRODUCT_DISCOVERY',
          productMatchConfidence: confidence,
          productMatchName: items[0]?.title ?? '',
        });
        if (items.length === 0) {
          return {
            ok: true,
            data: {
              results: [],
              confidence: 0,
              requiresClarification: true,
              voiceSummary:
                live.voiceSummary ??
                `I couldn't find that title in the catalog. Please share the ISBN and I'll check again.`,
            },
            meta: { source: 'shopify_live' },
          };
        }
        const top = items[0];
        const v0 = top.variants[0];
        const requiresClarification =
          topScore >= PRODUCT_SEARCH_CONFIRM_MIN_SCORE && topScore < PRODUCT_SEARCH_CONFIDENT_MIN_SCORE;
        const topMapped = {
          id: top.productId,
          title: top.title,
          handle: top.handle,
          isbn: top.isbn,
          relevanceScore: top.relevanceScore,
          matchReason: top.matchReason,
          variants: top.variants.map((v) => ({
            id: v.id,
            title: v.title,
            sku: v.sku,
            isbn: v.isbn,
            price: v.price,
            inventoryQuantity: v.inventory_quantity,
          })),
        };
        return {
          ok: true,
          data: {
            results: [topMapped],
            confidence,
            requiresClarification,
            confirmationQuestion: requiresClarification ? 'Is this the book you meant?' : null,
            voiceSummary:
              live.voiceSummary ??
              `I found ${top.title}${v0?.title ? ` ${v0.title}` : ''}${v0?.price ? ` for ${v0.price}` : ''}.`,
          },
          meta: { source: 'shopify_live' },
        };
      }
      case 'getProductDetails': {
        const shopDomain =
          ctx.agent.shopify?.shopDomain?.trim() ||
          normalizeShopifyDomain(ctx.agent.shopify?.storeUrl ?? null);
        const productIdArg = this.getStringArg(input, 'productId');
        const variantIdArg = this.getStringArg(input, 'variantId');
        const titleArg = this.getStringArg(input, 'title');
        let detailsMeta: 'product_cache' | 'shopify_live' = 'product_cache';
        let product = await this.productSearch.getDetails(
          ctx.tenantId,
          {
            productId: productIdArg,
            variantId: variantIdArg,
            title: titleArg,
          },
          shopDomain,
        );
        if (!product) {
          const live = await this.shopifyAgent.getProductLive(ctx.tenantId, ctx.agentId, {
            productId: productIdArg || undefined,
            variantId: variantIdArg || undefined,
            title: titleArg || undefined,
          });
          if (live) {
            product = this.mapLiveSummaryToDetailsProduct(live, variantIdArg || undefined);
            detailsMeta = 'shopify_live';
          }
        }
        if (!product) {
          return {
            ok: true,
            data: { product: null, voiceSummary: 'No products found in Shopify store.' },
            meta: { source: 'shopify_live' },
          };
        }
        await this.updateOrderStateMetadata(callSessionId, {
          orderState: 'PRODUCT_DISCOVERY',
          productMatchName: product.title,
        });
        const selectedId = 'selectedVariantId' in product ? product.selectedVariantId : null;
        return {
          ok: true,
          data: {
            product: {
              id: product.productId,
              title: product.title,
              handle: product.handle,
              isbn: product.isbn,
              selectedVariantId: selectedId ?? undefined,
              variants: product.variants.map((v) => ({
                id: v.variantId,
                title: v.title,
                sku: v.sku,
                isbn: v.isbn,
                price: v.price,
                inventoryQuantity: v.inventoryQuantity,
                availableForSale: v.availableForSale,
              })),
            },
            voiceSummary: selectedId
              ? `${product.title}. The variant you asked about is listed first; ${product.variants.length} options in total.`
              : `${product.title}. ${product.variants.length} variants available.`,
          },
          meta: { source: detailsMeta },
        };
      }
      case 'getProductAvailability': {
        const productId = this.getStringArg(input, 'productId');
        const variantId = this.getStringArg(input, 'variantId');
        if (!productId) {
          return {
            ok: false,
            error: { code: 'MISSING_INPUT', message: 'Need productId for availability check.', retryable: true },
          };
        }
        const shopDomain =
          ctx.agent.shopify?.shopDomain?.trim() ||
          normalizeShopifyDomain(ctx.agent.shopify?.storeUrl ?? null);
        let availabilityMeta: 'product_cache' | 'shopify_live' = 'product_cache';
        let product = await this.productSearch.getDetails(
          ctx.tenantId,
          { productId, variantId: variantId || undefined },
          shopDomain,
        );
        if (!product) {
          const live = await this.shopifyAgent.getProductLive(ctx.tenantId, ctx.agentId, {
            productId,
            variantId: variantId || undefined,
          });
          if (live) {
            product = this.mapLiveSummaryToDetailsProduct(live, variantId || undefined);
            availabilityMeta = 'shopify_live';
          }
        }
        if (!product) {
          return {
            ok: true,
            data: {
              available: false,
              product: null,
              voiceSummary: 'No products found in Shopify store.',
            },
            meta: { source: 'shopify_live' },
          };
        }
        const targetVariant = variantId
          ? product.variants.find((v) => v.variantId === variantId)
          : product.variants[0];
        const available =
          (targetVariant?.availableForSale ?? false) &&
          Number(targetVariant?.inventoryQuantity ?? 0) > 0;
        return {
          ok: true,
          data: {
            available,
            product: {
              id: product.productId,
              title: product.title,
            },
            variant: targetVariant
              ? {
                  id: targetVariant.variantId,
                  title: targetVariant.title,
                  price: targetVariant.price,
                  inventoryQuantity: targetVariant.inventoryQuantity,
                  availableForSale: targetVariant.availableForSale,
                }
              : null,
            voiceSummary: targetVariant
              ? `${product.title} (${targetVariant.title ?? 'default'}): ${available ? 'in stock' : 'currently unavailable'} at ${targetVariant.price ?? 'listed price unavailable'}.`
              : `${product.title} is available in ${product.variants.length} variants.`,
          },
          meta: { source: availabilityMeta },
        };
      }
      case 'createDraftOrder': {
        const metadata = await this.getSessionMetadata(callSessionId);
        const currentState = normalizeOrderState(metadata.orderState);
        if (ToolOrchestratorService.ORDER_STATE_SEQUENCE.indexOf(currentState) < ToolOrchestratorService.ORDER_STATE_SEQUENCE.indexOf('PRODUCT_DISCOVERY')) {
          return {
            ok: false,
            error: { code: 'PRECONDITION_FAILED', message: 'Product must be confirmed before draft order creation.', retryable: true },
            data: {
              voiceSummary: 'Tell me the book title or ISBN first, then we can continue.',
            },
          };
        }
        const customerObj =
          (input.customer as Record<string, unknown> | undefined) ?? {};
        const email = this.getStringArg(customerObj, 'email');
        if (!email) {
          return {
            ok: false,
            error: { code: 'MISSING_INPUT', message: 'Need customer.email to create draft order.', retryable: true },
          };
        }
        const itemsRaw = this.normalizeItems(input.items);
        if (itemsRaw.length === 0) {
          return {
            ok: false,
            error: { code: 'MISSING_INPUT', message: 'Need at least one item for draft order.', retryable: true },
          };
        }
        let checkout;
        try {
          checkout = await this.checkout.createCheckoutLink(ctx.tenantId, ctx.agentId, {
            callSessionId,
            customer: {
              email,
              name: this.getStringArg(customerObj, 'name') || undefined,
              phone: this.getStringArg(customerObj, 'phone') || undefined,
            },
            items: itemsRaw.map((item) => ({
              variantId: item.variantId ?? item.productId,
              quantity: item.quantity,
              title: item.title,
            })),
            mode: 'DRAFT_ORDER_INVOICE',
          });
        } catch (err) {
          const msg = formatShopifyErrorForCaller(err);
          return {
            ok: false,
            error: { code: 'DRAFT_ORDER_FAILED', message: msg, retryable: true },
            data: { voiceSummary: msg },
          };
        }
        await this.updateOrderStateMetadata(callSessionId, {
          orderState: 'EMAIL_COLLECTION',
          normalizedEmail: this.normalizeEmail(email),
          paymentLink: checkout.checkoutUrl,
        });
        return {
          ok: true,
          data: {
            checkoutLinkId: checkout.checkoutLinkId,
            checkoutUrl: checkout.checkoutUrl,
            mode: checkout.mode,
            voiceSummary: `I created a draft-order payment link and can send it to ${email}.`,
          },
          meta: { source: 'shopify_checkout' },
        };
      }
      case 'createCheckoutOrInvoicePaymentLink': {
        const order = (input.order as Record<string, unknown> | undefined) ?? {};
        const customer = (order.customer as Record<string, unknown> | undefined) ?? {};
        const email = this.getStringArg(customer, 'email');
        const itemsRaw = this.normalizeItems(order.items);
        const modeRaw = this.getStringArg(order, 'mode');
        if (!email) {
          return {
            ok: false,
            error: { code: 'MISSING_INPUT', message: 'Need order.customer.email before creating payment link.', retryable: true },
          };
        }
        if (itemsRaw.length === 0) {
          return {
            ok: false,
            error: { code: 'MISSING_INPUT', message: 'Need order.items before creating payment link.', retryable: true },
          };
        }
        const mode = modeRaw ? toCheckoutModeApi(modeRaw) : undefined;
        const forceNewCheckout = this.getBooleanArg(order, 'forceNewCheckout', 'force_new_checkout') === true;
        let checkout;
        try {
          checkout = await this.checkout.createCheckoutLink(ctx.tenantId, ctx.agentId, {
            callSessionId,
            customer: {
              email,
              name: this.getStringArg(customer, 'name') || undefined,
              phone: this.getStringArg(customer, 'phone') || undefined,
            },
            items: itemsRaw.map((item) => ({
              variantId: item.variantId ?? item.productId,
              quantity: item.quantity,
              title: item.title,
            })),
            mode,
            forceNewCheckout,
          });
        } catch (err) {
          const msg = formatShopifyErrorForCaller(err);
          return {
            ok: false,
            error: { code: 'CHECKOUT_FAILED', message: msg, retryable: true },
            data: { voiceSummary: msg },
          };
        }
        await this.updateOrderStateMetadata(callSessionId, {
          orderState: 'EMAIL_COLLECTION',
          normalizedEmail: this.normalizeEmail(email),
          paymentLink: checkout.checkoutUrl,
        });
        return {
          ok: true,
          data: {
            checkoutLinkId: checkout.checkoutLinkId,
            checkoutUrl: checkout.checkoutUrl,
            mode: checkout.mode,
            reusedExisting: checkout.reusedExisting === true,
            voiceSummary: `I created a secure ${checkout.mode === 'DRAFT_ORDER_INVOICE' ? 'invoice' : 'checkout'} payment link.`,
          },
          meta: { source: 'shopify_checkout' },
        };
      }
      case 'createCheckoutLink': {
        const metadata = await this.getSessionMetadata(callSessionId);
        const currentState = normalizeOrderState(metadata.orderState);
        if (ToolOrchestratorService.ORDER_STATE_SEQUENCE.indexOf(currentState) < ToolOrchestratorService.ORDER_STATE_SEQUENCE.indexOf('PRODUCT_DISCOVERY')) {
          return {
            ok: false,
            error: { code: 'PRECONDITION_FAILED', message: 'Product is required before payment link generation.', retryable: true },
            data: {
              voiceSummary: 'Let’s confirm the book first—what title or ISBN?',
            },
          };
        }
        const email = this.getStringArg(input, 'email');
        if (!email) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need customer email before creating checkout.', retryable: true } };
        }
        const itemsRaw = this.normalizeItems(input.items);
        const checkoutMode = this.getStringArg(input, 'mode').toLowerCase();
        const items = itemsRaw.map((item) => ({
          variantId: item.variantId ?? item.productId,
          quantity: item.quantity,
        }));
        if (items.length === 0) {
          return {
            ok: false,
            error: {
              code: 'MISSING_INPUT',
              message:
                'Need at least one line item with a Shopify variant or product id and quantity. Use getProductDetails first.',
              retryable: true,
            },
            data: {
              voiceSummary:
                'I need the exact product variant from our catalog before I can build checkout. Let me look that up again.',
            },
          };
        }
        const configuredMode = checkoutMode ? toCheckoutModeApi(checkoutMode) : undefined;
        const forceNewCheckout =
          this.getBooleanArg(input as Record<string, unknown>, 'forceNewCheckout', 'force_new_checkout') === true;
        this.logger.log(
          JSON.stringify({
            event: 'voice.journey.checkout_create_start',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            itemCount: items.length,
            modeHint: configuredMode ?? 'agent_default',
            forceNewCheckout,
          }),
        );
        let checkout: Awaited<ReturnType<ShopifyCheckoutService['createCheckoutLink']>>;
        try {
          checkout = await this.checkout.createCheckoutLink(ctx.tenantId, ctx.agentId, {
            callSessionId,
            customer: { email },
            items,
            mode: configuredMode,
            forceNewCheckout,
          });
        } catch (err) {
          const msg = formatShopifyErrorForCaller(err);
          const retryable =
            err instanceof ShopifyGraphqlError ? err.retryable : !(err instanceof ShopifyCheckoutValidationError);
          return {
            ok: false,
            error: { code: 'CHECKOUT_FAILED', message: msg, retryable },
            data: { voiceSummary: msg },
          };
        }
        const link = await this.prisma.checkoutLink.findUniqueOrThrow({
          where: { id: checkout.checkoutLinkId },
        });
        this.logger.log(
          JSON.stringify({
            event: 'voice.tool.checkout_link_created',
            eventJourney: 'voice.journey.checkout_link_created',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            checkoutLinkId: link.id,
            mode: link.mode,
            itemCount: items.length,
            reusedExisting: checkout.reusedExisting === true,
          }),
        );
        await this.updateOrderStateMetadata(callSessionId, {
          orderState: 'EMAIL_COLLECTION',
          normalizedEmail: this.normalizeEmail(email),
          paymentLink: link.checkoutUrl,
        });
        return {
          ok: true,
          data: {
            checkoutLinkId: link.id,
            checkoutUrl: link.checkoutUrl,
            mode: link.mode,
            reusedExisting: checkout.reusedExisting === true,
            voiceSummary:
              checkout.reusedExisting === true
                ? `You already have an open checkout for this cart; I'm using that same secure link for ${email}.`
                : `I created a secure payment link and can send it to ${email}.`,
          },
          meta: { source: 'shopify_checkout' },
        };
      }
      case 'sendPaymentEmail': {
        const metadata = await this.getSessionMetadata(callSessionId);
        const checkoutLinkIdInput = this.getStringArg(input, 'checkoutLinkId');
        const email = this.getStringArg(input, 'email');
        const checkoutLinkId = checkoutLinkIdInput;
        if (!email || !checkoutLinkId) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need email and checkoutLinkId to send payment email.', retryable: true } };
        }
        const link = await this.prisma.checkoutLink.findFirst({
          where: { id: checkoutLinkId, tenantId: ctx.tenantId, agentId: ctx.agentId },
          include: { agent: { include: { agentConfig: true, client: true } } },
        });
        if (!link) return { ok: false, error: { code: 'NOT_FOUND', message: 'Checkout link not found.', retryable: false } };
        const items = Array.isArray(link.itemsJson)
          ? (link.itemsJson as Array<{ title?: string; quantity?: number; price?: string | number }>).map((row) => ({
              title: row.title || 'Selected item',
              quantity: Math.max(1, Number(row.quantity ?? 1)),
              price: row.price != null ? String(row.price) : null,
            }))
          : [];
        const businessName =
          link.agent.agentConfig?.businessName?.trim() ||
          link.agent.client?.name?.trim() ||
          ctx.store.name;
        const supportEmail =
          link.agent.agentConfig?.supportEmail || link.agent.client?.contactEmail || null;
        const supportPhone =
          link.agent.agentConfig?.supportPhone || link.agent.client?.contactPhone || null;
        const emailConfig = await this.agentEmailConfig.resolveForSend(ctx.tenantId, ctx.agentId);
        if (!emailConfig) {
          return {
            ok: false,
            error: {
              code: 'EMAIL_NOT_CONFIGURED',
              message: 'Payment email is not configured for this agent.',
              retryable: false,
            },
            data: {
              voiceSummary:
                'I cannot send a payment email right now because email is not set up for this store. Let me connect you with support to complete your order.',
              escalateRecommended: true,
            },
          };
        }
        let sendResult: {
          emailEventId: string;
          providerMessageId: string | null;
          deduplicated?: boolean;
        };
        try {
          sendResult = await this.resendEmail.sendPaymentEmail({
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            callSessionId,
            checkoutLinkId: link.id,
            idempotencyKey: paymentEmailIdempotencyKey({
              tenantId: ctx.tenantId,
              agentId: ctx.agentId,
              checkoutLinkId: link.id,
              recipientEmail: email,
              purpose: 'voice_tool_send_payment_email',
            }),
            to: email,
            businessName,
            supportEmail,
            supportPhone,
            checkoutUrl: link.checkoutUrl,
            items,
            emailConfig,
          });
          if (!sendResult.deduplicated) {
            await this.prisma.checkoutLink.updateMany({
              where: { id: link.id, tenantId: ctx.tenantId, agentId: ctx.agentId },
              data: { status: 'SENT', sentAt: new Date() },
            });
          }
        } catch (err) {
          const inFlight =
            err instanceof Error && err.message.includes('already being sent for this checkout');
          if (inFlight) {
            return {
              ok: false,
              error: {
                code: 'EMAIL_IN_FLIGHT',
                message: err instanceof Error ? err.message : 'Email send in progress',
                retryable: true,
              },
              data: {
                voiceSummary:
                  'The payment email is still being sent. Please wait a few seconds, check your inbox, or ask me to try again.',
              },
            };
          }
          await this.prisma.checkoutLink.updateMany({
            where: { id: link.id, tenantId: ctx.tenantId, agentId: ctx.agentId },
            data: {
              status: CheckoutLinkStatus.FAILED,
              metadata: {
                emailSendError:
                  err instanceof Error ? err.message.slice(0, 300) : 'unknown_error',
              },
            },
          });
          throw err;
        }
        if (!sendResult.deduplicated) {
          await this.prisma.leadCapture.create({
            data: {
              tenantId: ctx.tenantId,
              agentId: ctx.agentId,
              callSessionId,
              customerEmail: email,
              intent: 'purchase_checkout',
              interestedItems:
                (link.itemsJson as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
              metadata: {
                checkoutLinkId: link.id,
                checkoutMode: link.mode,
                emailSent: true,
              } as Prisma.InputJsonValue,
            },
          });
        }
        this.logger.log(
          JSON.stringify({
            event: 'voice.tool.payment_email_sent',
            eventJourney: 'voice.journey.payment_email_sent',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            checkoutLinkId: link.id,
            recipientEmailMasked: this.maskEmailForLog(email),
            deduplicated: sendResult.deduplicated === true,
          }),
        );
        await this.updateOrderStateMetadata(callSessionId, {
          orderState: 'DONE',
        });
        return {
          ok: true,
          data: {
            deduplicated: sendResult.deduplicated === true,
            deliveryConfirmed: true,
            voiceSummary:
              sendResult.deduplicated === true
                ? `That link was already sent to ${email}. Check your inbox.`
                : `You’ll receive the payment link shortly. Let me know if you need anything else.`,
          },
          meta: { source: 'resend' },
        };
      }
      case 'captureLead': {
        await this.prisma.leadCapture.create({
          data: {
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            callSessionId,
            customerName: this.getStringArg(input, 'customerName') || null,
            customerEmail: this.getStringArg(input, 'customerEmail') || null,
            customerPhone: this.getStringArg(input, 'customerPhone') || null,
            intent: this.getStringArg(input, 'intent') || null,
            interestedItems:
              (input.interestedItems as unknown as Prisma.InputJsonValue | undefined) ??
              Prisma.JsonNull,
            metadata: input as unknown as Prisma.InputJsonValue,
          },
        });
        return { ok: true, data: { voiceSummary: 'I captured your details and will share them with the team.' }, meta: { source: 'database' } };
      }
      case 'escalateToHuman': {
        const reason = this.getStringArg(input, 'reason') || 'customer_requested_human';
        const phone = ctx.fromNumber || this.getStringArg(input, 'phone');
        if (phone) {
          await this.callbacks.create({
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            callSessionId,
            phone,
            reason,
            priority: 'high',
            notes: 'Escalation requested through new tool.',
          });
          await this.callbacks.markRequestedOnSession(callSessionId);
        }
        const msg = 'I can connect you with a human support teammate.';
        return {
          ok: true,
          data: { queued: true, reason, message: msg, voiceSummary: msg },
          meta: { source: 'system' },
        };
      }
      case 'get_order_status': {
        const orderNumber = this.getStringArg(input, 'orderNumber', 'order_number');
        const phone = this.getStringArg(input, 'phone');
        if (!orderNumber) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need orderNumber before calling get_order_status.', retryable: true } };
        }
        if (!phone) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need phone for verification before order lookup.', retryable: true } };
        }
        const result = await this.shopifyAgent.getOrderStatus(ctx.tenantId, ctx.agentId, orderNumber);
        if (!result.ok) return { ok: false, error: { code: 'SHOPIFY_ERROR', message: result.error ?? 'Order lookup failed.', retryable: true } };
        return { ok: true, data: { verifiedWithPhone: phone.slice(-4), orders: result.orders, voiceSummary: result.voiceSummary }, meta: { source: 'shopify' } };
      }
      case 'search_books': {
        const query = (input.query as string) || (input.title as string) || '';
        const result = await this.shopifyAgent.searchProducts(ctx.tenantId, ctx.agentId, query, 5);
        if (!result.ok) return { ok: false, error: { code: 'SHOPIFY_ERROR', message: result.error ?? 'Product search failed.', retryable: true } };
        return { ok: true, data: { results: result.products, voiceSummary: result.voiceSummary }, meta: { source: 'shopify' } };
      }
      case 'get_book_details': {
        const query = this.getStringArg(input, 'productId', 'product_id', 'title');
        if (!query) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need productId to fetch product details.', retryable: true } };
        }
        const result = await this.shopifyAgent.searchProducts(ctx.tenantId, ctx.agentId, query, 1);
        if (!result.ok) return { ok: false, error: { code: 'SHOPIFY_ERROR', message: result.error ?? 'Product details failed.', retryable: true } };
        const product = result.products?.[0];
        const voiceSummary = product ? `${product.title}. Variants: ${product.variants?.length ?? 0}. ${product.variants?.some((v) => v.inventory_quantity > 0) ? 'In stock.' : 'Out of stock.'}` : 'Product not found.';
        return { ok: true, data: { product, voiceSummary }, meta: { source: 'shopify' } };
      }
      case 'check_book_inventory': {
        const query = this.getStringArg(input, 'productId', 'product_id', 'title', 'query');
        if (!query) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need productId to check inventory.', retryable: true } };
        }
        const result = await this.shopifyAgent.searchProducts(ctx.tenantId, ctx.agentId, query, 1);
        if (!result.ok) return { ok: false, error: { code: 'SHOPIFY_ERROR', message: result.error ?? 'Inventory check failed.', retryable: true } };
        const product = result.products?.[0];
        const inStock = product?.variants?.some((v) => v.inventory_quantity > 0) ?? false;
        const voiceSummary = product ? `${product.title}: ${inStock ? 'In stock.' : 'Currently out of stock.'}` : 'Product not found.';
        return { ok: true, data: { inStock, product, voiceSummary }, meta: { source: 'shopify' } };
      }
      case 'get_store_locations': {
        const locs = await this.retrieval.getBranchProfiles(ctx.tenantId, ctx.storeId!, input.branchId as string | undefined, input.city as string | undefined);
        return { ok: true, data: { items: locs.items, voiceSummary: locs.voiceSummary, storeName: ctx.store.name }, meta: { source: locs.source } };
      }
      case 'get_store_hours': {
        const hours = await this.retrieval.getStoreHours(ctx.tenantId, ctx.storeId!, input.branchId as string | undefined);
        return { ok: true, data: { items: hours.items, voiceSummary: hours.voiceSummary }, meta: { source: hours.source } };
      }
      case 'search_store_faqs':
      case 'retrieve_knowledge_base': {
        const query = (input.query as string) || '';
        if (!query.trim()) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Query required.', retryable: true } };
        }
        try {
          const rag = await this.retrievalOrchestrator.retrieve({
            tenantId: ctx.tenantId,
            storeId: ctx.storeId!,
            query,
            branchProfileId: input.branchProfileId as string | undefined,
            topK: 5,
          });
          if (rag.ok && rag.items.length > 0) {
            return {
              ok: true,
              data: { items: rag.items, voiceSummary: rag.voiceSummary, source: rag.source },
              meta: { source: rag.source },
            };
          }
        } catch {
          /* fall through to keyword FAQ */
        }
        const faqs = await this.retrieval.searchFaqs(
          ctx.tenantId,
          ctx.storeId!,
          query,
          input.branchProfileId as string | undefined,
          5,
        );
        return { ok: true, data: { items: faqs.items, voiceSummary: faqs.voiceSummary }, meta: { source: faqs.source } };
      }
      case 'get_shipping_policy': {
        const ship = await this.retrieval.getPolicy(ctx.tenantId, ctx.storeId!, KnowledgeDocType.SHIPPING_POLICY, input.branchProfileId as string | undefined);
        return { ok: true, data: { items: ship.items, voiceSummary: ship.voiceSummary }, meta: { source: ship.source } };
      }
      case 'get_return_policy': {
        const ret = await this.retrieval.getPolicy(ctx.tenantId, ctx.storeId!, KnowledgeDocType.RETURN_POLICY, input.branchProfileId as string | undefined);
        return { ok: true, data: { items: ret.items, voiceSummary: ret.voiceSummary }, meta: { source: ret.source } };
      }
      case 'get_promotion_details': {
        const prom = await this.retrieval.getPromotionDetails(ctx.tenantId, ctx.storeId!, input.branchProfileId as string | undefined);
        return { ok: true, data: { items: prom.items, voiceSummary: prom.voiceSummary }, meta: { source: prom.source } };
      }
      case 'start_order_booking': {
        const items = this.normalizeItems(input.items);
        if (items.length === 0) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need at least one item to start booking.', retryable: true } };
        }
        const draft = await this.booking.startBooking(callSessionId, ctx.tenantId, ctx.agentId, items);
        await this.updateOrderStateMetadata(callSessionId, {
          orderState: 'PRODUCT_DISCOVERY',
          quantity: items.reduce((sum, item) => sum + item.quantity, 0),
        });
        return { ok: true, data: { bookingId: draft.id, itemCount: items.length, voiceSummary: `Added ${items.length} item(s) to your order draft.` }, meta: { source: 'database' } };
      }
      case 'set_customer_details': {
        const name = this.getStringArg(input, 'name');
        const phone = this.getStringArg(input, 'phone');
        const email = this.getStringArg(input, 'email');
        if (!name || !phone) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need both name and phone for customer details.', retryable: true } };
        }
        await this.booking.setCustomerDetails(callSessionId, ctx.tenantId, ctx.agentId, { name, phone, email: email || undefined });
        await this.updateOrderStateMetadata(callSessionId, {
          orderState: 'EMAIL_COLLECTION',
          customerName: name,
          normalizedEmail: email ? this.normalizeEmail(email) : '',
        });
        return { ok: true, data: { voiceSummary: 'Saved customer details for this order.' }, meta: { source: 'database' } };
      }
      case 'set_delivery_details': {
        const addressLine1 = this.getStringArg(input, 'addressLine1', 'address_line1', 'address');
        const city = this.getStringArg(input, 'city');
        const postalCode = this.getStringArg(input, 'postalCode', 'postal_code', 'zip');
        const country = this.getStringArg(input, 'country');
        if (!addressLine1 || !city) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need addressLine1 and city for delivery details.', retryable: true } };
        }
        await this.booking.setDeliveryDetails(callSessionId, ctx.tenantId, ctx.agentId, { addressLine1, city, postalCode: postalCode || undefined, country: country || undefined });
        return { ok: true, data: { voiceSummary: 'Saved delivery details.' }, meta: { source: 'database' } };
      }
      case 'confirm_order_summary': {
        const confirmed = this.getBooleanArg(input, 'confirmed', 'isConfirmed');
        if (confirmed === null) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need confirmed=true or confirmed=false.', retryable: true } };
        }
        await this.booking.confirmOrderSummary(callSessionId, ctx.tenantId, ctx.agentId, confirmed);
        await this.updateOrderStateMetadata(callSessionId, {
          orderState: 'EMAIL_COLLECTION',
        });
        return {
          ok: true,
          data: {
            confirmed,
            voiceSummary: confirmed
              ? 'Order summary confirmed. I can now generate your secure payment link.'
              : 'No problem. I will keep your order as draft until you confirm.',
          },
          meta: { source: 'database' },
        };
      }
      case 'create_payment_checkout_link': {
        const draft = await this.booking.getDraft(callSessionId);
        if (!draft || draft.status !== 'READY_FOR_PAYMENT') {
          return { ok: false, error: { code: 'PRECONDITION_FAILED', message: 'Order must be confirmed before creating checkout link.', retryable: true } };
        }
        const channelRaw = this.getStringArg(input, 'channel').toLowerCase();
        const channel = channelRaw === 'email' ? 'email' : 'sms';
        const destination = this.getStringArg(
          input,
          'destination',
          channel === 'email' ? 'email' : 'phone',
          channel === 'email' ? 'phone' : 'email',
        );
        if (!destination) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need destination phone/email for checkout link delivery.', retryable: true } };
        }

        const itemsRaw = Array.isArray(draft.itemsJson) ? (draft.itemsJson as unknown[]) : [];
        const items = itemsRaw
          .map((row) => {
            if (!row || typeof row !== 'object') return null;
            const r = row as Record<string, unknown>;
            return {
              productId: this.getStringArg(r, 'productId', 'product_id'),
              variantId: this.getStringArg(r, 'variantId', 'variant_id'),
              title: this.getStringArg(r, 'title'),
              quantity: typeof r.quantity === 'number' ? r.quantity : Number(r.quantity ?? 1),
            };
          })
          .filter((i): i is NonNullable<typeof i> => Boolean(i && (i.productId || i.variantId || i.title)));
        const customer = (draft.customerJson as Record<string, unknown> | null) ?? {};
        const deliveryAddress = (draft.deliveryAddressJson as Record<string, unknown> | null) ?? {};
        const customerEmail = this.getStringArg(customer, 'email');
        const customerPhone = this.getStringArg(customer, 'phone');
        const destinationEmail = channel === 'email' ? destination : this.getStringArg(input, 'email');
        const destinationPhone = channel === 'sms' ? destination : this.getStringArg(input, 'phone');
        if (
          isEmailRequiredBeforeCheckout({
            askEmailBeforePaymentLink: ctx.agent.config?.askEmailBeforePaymentLink,
            customerEmail,
            destinationEmail,
          })
        ) {
          return {
            ok: false,
            error: {
              code: 'EMAIL_REQUIRED',
              message: 'Customer email is required before sending a payment link.',
              retryable: true,
            },
            data: {
              requiredField: 'email',
              voiceSummary:
                'Before I send the secure payment link, please share the best email address for your checkout receipt.',
            },
          };
        }

        let checkout: Awaited<ReturnType<ShopifyCheckoutService['createCheckoutLink']>>;
        try {
          checkout = await this.checkout.createCheckoutLink(ctx.tenantId, ctx.agentId, {
            callSessionId,
            items,
            customer: {
              name: this.getStringArg(customer, 'name') || undefined,
              phone: customerPhone || destinationPhone || undefined,
              email: customerEmail || destinationEmail || undefined,
            },
            deliveryAddress: {
              addressLine1: this.getStringArg(deliveryAddress, 'addressLine1', 'address_line1', 'address') || undefined,
              city: this.getStringArg(deliveryAddress, 'city') || undefined,
              postalCode: this.getStringArg(deliveryAddress, 'postalCode', 'postal_code', 'zip') || undefined,
              country: this.getStringArg(deliveryAddress, 'country') || undefined,
            },
          });
        } catch (err) {
          const msg = formatShopifyErrorForCaller(err);
          const retryable =
            err instanceof ShopifyGraphqlError ? err.retryable : !(err instanceof ShopifyCheckoutValidationError);
          return {
            ok: false,
            error: { code: 'CHECKOUT_FAILED', message: msg, retryable },
            data: { voiceSummary: msg },
          };
        }

        await this.booking.attachCheckoutLink(callSessionId, checkout.checkoutUrl, channel, destination);
        await this.updateOrderStateMetadata(callSessionId, {
          orderState: 'EMAIL_COLLECTION',
          paymentLink: checkout.checkoutUrl,
        });
        const maskedDestination =
          channel === 'email'
            ? destination.replace(/^(.).+(@.*)$/, '$1***$2')
            : destination.replace(/.(?=.{4})/g, '*');

        let channelDeliveryStatus = 'generated';
        let bookingEmailDeduped = false;
        if (channel === 'sms') {
          const twilioCfg = await this.agentsService.getTwilioConfig(ctx.tenantId, ctx.agentId);
          const fromNumber = twilioCfg?.messagingFrom?.trim() || this.twilioSms.defaultMessagingFrom();
          if (!twilioCfg || !fromNumber) {
            channelDeliveryStatus = 'sms_not_configured';
          } else {
            try {
              await this.twilioSms.sendSms({
                accountSid: twilioCfg.accountSid,
                authToken: twilioCfg.authToken,
                from: fromNumber,
                to: destination,
                body: `Secure checkout for ${ctx.store.name}: ${checkout.checkoutUrl}`,
              });
              channelDeliveryStatus = 'sms_sent';
            } catch {
              channelDeliveryStatus = 'sms_failed';
            }
          }
        } else {
          const bookingEmailCfg = await this.agentEmailConfig.resolveForSend(ctx.tenantId, ctx.agentId);
          if (!bookingEmailCfg) {
            channelDeliveryStatus = 'email_not_configured';
          } else {
          const agentCfg = ctx.agent.config;
          let businessName: string | null = agentCfg?.businessName?.trim() || null;
          let supportEmail = agentCfg?.supportEmail ?? null;
          let supportPhone = agentCfg?.supportPhone ?? null;
          if (!agentCfg?.businessName || !supportEmail || !supportPhone) {
            const agentContact = await this.prisma.agent.findFirst({
              where: { id: ctx.agentId, tenantId: ctx.tenantId, deletedAt: null },
              select: {
                client: {
                  select: {
                    name: true,
                    contactEmail: true,
                    contactPhone: true,
                  },
                },
              },
            });
            businessName = businessName || agentContact?.client?.name?.trim() || null;
            supportEmail = supportEmail || agentContact?.client?.contactEmail || null;
            supportPhone = supportPhone || agentContact?.client?.contactPhone || null;
          }
          const itemsForEmail = items
            .map((row) => {
              if (!row || typeof row !== 'object') return null;
              const r = row as Record<string, unknown>;
              const title = this.getStringArg(r, 'title') || 'Selected item';
              const quantity = typeof r.quantity === 'number' ? r.quantity : Number(r.quantity ?? 1);
              return { title, quantity: Math.max(1, Number.isFinite(quantity) ? Math.trunc(quantity) : 1) };
            })
            .filter((i): i is { title: string; quantity: number } => i !== null);
          try {
            const bookingSend = await this.resendEmail.sendPaymentEmail({
              tenantId: ctx.tenantId,
              agentId: ctx.agentId,
              callSessionId,
              checkoutLinkId: checkout.checkoutLinkId,
              idempotencyKey: paymentEmailIdempotencyKey({
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                checkoutLinkId: checkout.checkoutLinkId,
                recipientEmail: destination,
                purpose: 'voice_tool_booking_checkout_email',
              }),
              to: destination,
              businessName: businessName || ctx.store.name,
              supportEmail,
              supportPhone,
              checkoutUrl: checkout.checkoutUrl,
              items: itemsForEmail.length > 0 ? itemsForEmail : [{ title: 'Items from your order', quantity: 1 }],
              emailConfig: bookingEmailCfg,
            });
            bookingEmailDeduped = bookingSend.deduplicated === true;
            await this.prisma.checkoutLink.updateMany({
              where: {
                id: checkout.checkoutLinkId,
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
              },
              data: { status: 'SENT', sentAt: new Date() },
            });
            channelDeliveryStatus = 'email_sent';
            if (!bookingSend.deduplicated) {
              await this.prisma.leadCapture.create({
                data: {
                  tenantId: ctx.tenantId,
                  agentId: ctx.agentId,
                  callSessionId,
                  customerEmail: destination.trim().toLowerCase(),
                  intent: 'purchase_checkout_booking',
                  interestedItems: (draft.itemsJson as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
                  metadata: {
                    checkoutLinkId: checkout.checkoutLinkId,
                    channel: 'email',
                  } as Prisma.InputJsonValue,
                },
              });
            }
          } catch (err) {
            const inFlight =
              err instanceof Error && err.message.includes('already being sent for this checkout');
            if (inFlight) {
              channelDeliveryStatus = 'email_in_progress';
            } else {
              channelDeliveryStatus = 'email_failed';
              await this.prisma.checkoutLink.updateMany({
                where: {
                  id: checkout.checkoutLinkId,
                  tenantId: ctx.tenantId,
                  agentId: ctx.agentId,
                },
                data: { status: CheckoutLinkStatus.FAILED },
              });
            }
          }
          }
        }

        const deliveryConfirmed =
          (channel === 'sms' && channelDeliveryStatus === 'sms_sent') ||
          (channel === 'email' && channelDeliveryStatus === 'email_sent');
        return {
          ok: deliveryConfirmed,
          data: {
            checkoutUrl: checkout.checkoutUrl,
            channelDeliveryStatus,
            deliveryConfirmed,
            maskedDestination,
            voiceSummary:
              channel === 'sms' && channelDeliveryStatus === 'sms_sent'
                ? `I texted your secure Shopify checkout link to ${maskedDestination}. Please complete payment there.`
                : channel === 'sms' && channelDeliveryStatus === 'sms_not_configured'
                  ? `I generated your secure checkout link, but SMS is not configured yet. I can read the link aloud or email it if you prefer.`
                  : channel === 'email' && channelDeliveryStatus === 'email_sent' && bookingEmailDeduped
                    ? `That checkout link was already emailed to ${maskedDestination}. Check your inbox or spam folder.`
                    : channel === 'email' && channelDeliveryStatus === 'email_sent'
                      ? `I emailed your secure checkout link to ${maskedDestination}.`
                      : channel === 'email' && channelDeliveryStatus === 'email_in_progress'
                        ? `Your checkout email is still sending — please wait a few seconds and check ${maskedDestination}.`
                        : channel === 'email' && channelDeliveryStatus === 'email_failed'
                          ? `I created your checkout link but could not send email. I can text the link or read it aloud.`
                          : `I generated your secure Shopify checkout link.`,
          },
          meta: { source: 'shopify' },
        };
      }
      case 'create_callback_request':
      {
        const phone = this.getStringArg(input, 'phone') || ctx.fromNumber || '';
        const reason = this.getStringArg(input, 'reason') || 'Caller requested callback';
        if (!phone) return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need callback phone to create callback request.', retryable: true } };
        await this.callbacks.create({
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          callSessionId,
          phone,
          reason,
          priority: this.getStringArg(input, 'priority') as 'low' | 'normal' | 'high',
          notes: this.getStringArg(input, 'notes') || undefined,
        });
        await this.callbacks.markRequestedOnSession(callSessionId);
        return {
          ok: true,
          data: {
            queued: true,
            message: 'Callback request registered. We will call you back shortly.',
            voiceSummary: 'I have queued a callback with your number. Someone from the team should reach you soon.',
          },
          meta: { source: 'database' },
        };
      }
      case 'search_collections': {
        const query = this.getStringArg(input, 'query') || '';
        const limit = Math.min(Number(input.limit) || 5, 10);
        const shopDomain =
          ctx.agent.shopify?.shopDomain?.trim() ||
          normalizeShopifyDomain(ctx.agent.shopify?.storeUrl ?? null);
        const products = await this.productSearch.search(ctx.tenantId, query, limit, shopDomain);
        const collections = new Map<string, { title: string; count: number }>();
        for (const p of products) {
          const type = p.productType?.trim() || 'General';
          const prev = collections.get(type) ?? { title: type, count: 0 };
          prev.count += 1;
          collections.set(type, prev);
        }
        const items = Array.from(collections.values());
        const voiceSummary =
          items.length > 0
            ? `Found ${items.length} categories matching "${query}". Top: ${items[0].title} (${items[0].count} items).`
            : `No categories found for "${query}" in our catalog.`;
        return { ok: true, data: { items, voiceSummary }, meta: { source: 'shopify_cache' } };
      }
      case 'lookup_variant': {
        const shopDomain =
          ctx.agent.shopify?.shopDomain?.trim() ||
          normalizeShopifyDomain(ctx.agent.shopify?.storeUrl ?? null);
        const details = await this.productSearch.getDetails(
          ctx.tenantId,
          {
            productId: this.getStringArg(input, 'productId') || undefined,
            variantId: this.getStringArg(input, 'variantId') || undefined,
            title: undefined,
          },
          shopDomain,
        );
        if (!details) {
          return { ok: false, error: { code: 'NOT_FOUND', message: 'Variant not found.', retryable: false } };
        }
        const sku = this.getStringArg(input, 'sku');
        const variant = sku
          ? details.variants.find((v) => v.sku?.toLowerCase() === sku.toLowerCase()) ?? details.variants[0]
          : details.variants[0];
        return {
          ok: true,
          data: { product: details, variant, voiceSummary: variant ? `${details.title}, ${variant.title}: ${variant.price ?? 'price on request'}.` : details.title },
          meta: { source: 'shopify_cache' },
        };
      }
      case 'validate_price': {
        const shopDomain =
          ctx.agent.shopify?.shopDomain?.trim() ||
          normalizeShopifyDomain(ctx.agent.shopify?.storeUrl ?? null);
        const details = await this.productSearch.getDetails(
          ctx.tenantId,
          {
            productId: this.getStringArg(input, 'productId') || undefined,
            variantId: this.getStringArg(input, 'variantId') || undefined,
          },
          shopDomain,
        );
        if (!details) {
          return { ok: false, error: { code: 'NOT_FOUND', message: 'Product not found.', retryable: false } };
        }
        const quoted = this.getStringArg(input, 'quotedPrice');
        const variant = details.variants[0];
        const actual = variant?.price ?? null;
        const match = quoted && actual ? quoted.replace(/[^\d.]/g, '') === actual.replace(/[^\d.]/g, '') : null;
        return {
          ok: true,
          data: {
            actualPrice: actual,
            quotedPrice: quoted,
            priceMatches: match,
            voiceSummary: actual
              ? `The correct price is ${actual}${match === false ? ', which differs from what you mentioned.' : '.'}`
              : 'Price is not available in catalog.',
          },
          meta: { source: 'shopify_cache' },
        };
      }
      case 'check_live_inventory': {
        const productId = this.getStringArg(input, 'productId');
        if (!productId) {
          return { ok: false, error: { code: 'MISSING_INPUT', message: 'productId required.', retryable: true } };
        }
        const live = await this.shopifyAgent.getProductLive(ctx.tenantId, ctx.agentId, {
          productId,
          variantId: this.getStringArg(input, 'variantId') || undefined,
        });
        if (!live) {
          return { ok: false, error: { code: 'SHOPIFY_ERROR', message: 'Inventory check failed.', retryable: true } };
        }
        const variantId = this.getStringArg(input, 'variantId');
        const variant = variantId
          ? live.variants.find((v) => v.id === variantId) ?? live.variants[0]
          : live.variants[0];
        const qty = variant?.inventory_quantity ?? 0;
        return {
          ok: true,
          data: {
            inStock: qty > 0,
            quantity: qty,
            voiceSummary: qty > 0 ? `${live.title} has ${qty} in stock.` : `${live.title} is currently out of stock.`,
          },
          meta: { source: 'shopify_live' },
        };
      }
      case 'lookup_discount': {
        const prom = await this.retrieval.getPromotionDetails(ctx.tenantId, ctx.storeId!, undefined);
        const code = this.getStringArg(input, 'code');
        const voiceSummary =
          prom.items.length > 0
            ? prom.voiceSummary
            : code
              ? `No active promotion found for code "${code}".`
              : 'No active promotions in our knowledge base right now.';
        return { ok: true, data: { items: prom.items, code, voiceSummary }, meta: { source: prom.source } };
      }
      case 'estimate_shipping': {
        const ship = await this.retrieval.getPolicy(ctx.tenantId, ctx.storeId!, KnowledgeDocType.SHIPPING_POLICY, undefined);
        const city = this.getStringArg(input, 'city');
        const voiceSummary = ship.voiceSummary?.trim()
          ? `${ship.voiceSummary}${city ? ` (asked about ${city})` : ''}`
          : 'Shipping estimates follow our store policy—exact rates appear at Shopify checkout.';
        return { ok: true, data: { items: ship.items, city, voiceSummary }, meta: { source: ship.source } };
      }
      case 'get_store_policy': {
        const topic = this.getStringArg(input, 'topic') || 'general';
        const docType =
          topic === 'shipping'
            ? KnowledgeDocType.SHIPPING_POLICY
            : topic === 'returns'
              ? KnowledgeDocType.RETURN_POLICY
              : KnowledgeDocType.CUSTOM;
        const policy = await this.retrieval.getPolicy(ctx.tenantId, ctx.storeId!, docType, undefined);
        return { ok: true, data: { topic, items: policy.items, voiceSummary: policy.voiceSummary }, meta: { source: policy.source } };
      }
      case 'handoff_to_human': {
        const reason = this.getStringArg(input, 'reason') || 'handoff';
        const phone = ctx.fromNumber || this.getStringArg(input, 'phone');
        if (phone) {
          await this.callbacks.create({
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            callSessionId,
            phone,
            reason,
            priority: 'high',
            notes: 'Escalation requested during live call.',
          });
          await this.callbacks.markRequestedOnSession(callSessionId);
        }
        const msg = ctx.agent.escalationMessage || 'I will connect you with a team member and arrange a callback.';
        return {
          ok: true,
          data: { queued: true, reason, message: msg, voiceSummary: msg },
          meta: { source: 'system' },
        };
      }
      default:
        return {
          ok: false,
          error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${toolName}`, retryable: false },
          data: {
            voiceSummary:
              'That specific action is not available on this assistant. I can help with catalog search, checkout by email, order status, or arrange a callback.',
          },
        };
    }
  }

  private async logAndReturn(
    ctx: VoiceSessionContext,
    callSessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    requestId: string | undefined,
    start: number,
    result: ToolResult | Omit<ToolResult, 'toolName' | 'storeId'>,
  ): Promise<ToolResult> {
    const latencyMs = Date.now() - start;
    let fullResult: ToolResult = 'storeId' in result ? result : { ...result, toolName, storeId: ctx.storeId ?? null };
    if (!fullResult.ok) {
      const prev =
        fullResult.data && typeof fullResult.data === 'object' && fullResult.data !== null
          ? (fullResult.data as Record<string, unknown>)
          : {};
      const vs = prev.voiceSummary;
      if (typeof vs !== 'string' || !vs.trim()) {
        fullResult = {
          ...fullResult,
          data: {
            ...prev,
            voiceSummary:
              'I hit a snag while checking that. I can try once more with corrected details, arrange a callback, or connect you with support.',
          },
        };
      }
    }
    const status = fullResult.ok ? ToolExecutionStatus.SUCCESS : ToolExecutionStatus.FAILED;
    this.logger.log(
      JSON.stringify({
        event: 'voice.tool.execute_finish',
        eventJourney: fullResult.ok ? 'voice.journey.tool_success' : 'voice.journey.tool_failed',
        callSessionId,
        toolName,
        ok: fullResult.ok,
        status,
        latencyMs,
        errorCode: fullResult.error?.code,
      }),
    );
    await this.prisma.toolExecution.create({
      data: {
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        callSessionId,
        requestId,
        toolName,
        inputJson: input as object,
        outputJson: fullResult as object,
        status,
        errorMessage: fullResult.error?.message,
        latencyMs,
      },
    });
    await this.callEvents.log(
      ctx.tenantId,
      callSessionId,
      fullResult.ok ? CallEventType.TOOL_SUCCEEDED : CallEventType.TOOL_FAILED,
      { toolName, latencyMs, error: fullResult.error?.message },
    );
    return {
      ...fullResult,
      meta: { source: fullResult.meta?.source ?? 'unknown', ...fullResult.meta, latencyMs },
    };
  }

  getMaxToolCallsPerCall(): number {
    return MAX_TOOL_CALLS_PER_CALL;
  }
}
