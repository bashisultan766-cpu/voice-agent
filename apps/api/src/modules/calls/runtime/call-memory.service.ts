import { Injectable } from '@nestjs/common';
import type { CallConversationMemory } from '@bookstore-voice-agents/types';
import { PrismaService } from '../../../database/prisma.service';

const MEMORY_KEY = 'conversationMemory';

@Injectable()
export class CallMemoryService {
  constructor(private readonly prisma: PrismaService) {}

  async load(callSessionId: string): Promise<CallConversationMemory> {
    const session = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      select: { metadata: true },
    });
    const meta = (session?.metadata ?? {}) as Record<string, unknown>;
    const mem = meta[MEMORY_KEY];
    if (mem && typeof mem === 'object') return mem as CallConversationMemory;
    return {};
  }

  async merge(
    callSessionId: string,
    patch: Partial<CallConversationMemory>,
  ): Promise<CallConversationMemory> {
    const current = await this.load(callSessionId);
    const next: CallConversationMemory = {
      ...current,
      ...patch,
      mentionedProducts: patch.mentionedProducts ?? current.mentionedProducts,
      lastToolCalls: patch.lastToolCalls ?? current.lastToolCalls,
      customerPreferences: { ...current.customerPreferences, ...patch.customerPreferences },
    };
    const session = await this.prisma.callSession.findUnique({
      where: { id: callSessionId },
      select: { metadata: true },
    });
    const meta = { ...((session?.metadata ?? {}) as Record<string, unknown>), [MEMORY_KEY]: next };
    await this.prisma.callSession.update({
      where: { id: callSessionId },
      data: { metadata: meta as object },
    });
    return next;
  }

  async recordToolCall(
    callSessionId: string,
    toolName: string,
    ok: boolean,
  ): Promise<void> {
    const mem = await this.load(callSessionId);
    const calls = [...(mem.lastToolCalls ?? [])];
    calls.push({ toolName, ok, at: new Date().toISOString() });
    if (calls.length > 20) calls.splice(0, calls.length - 20);
    await this.merge(callSessionId, {
      lastToolCalls: calls,
      turnCount: (mem.turnCount ?? 0) + 1,
    });
  }

  async recordProduct(
    callSessionId: string,
    product: { productId?: string; title: string; variantId?: string },
  ): Promise<void> {
    const mem = await this.load(callSessionId);
    const list = [...(mem.mentionedProducts ?? [])];
    if (!list.some((p) => p.title === product.title && p.productId === product.productId)) {
      list.push(product);
      if (list.length > 15) list.shift();
    }
    await this.merge(callSessionId, { mentionedProducts: list });
  }
}
