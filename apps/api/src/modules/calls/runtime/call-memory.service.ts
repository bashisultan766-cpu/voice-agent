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
      discussedProducts: patch.discussedProducts ?? current.discussedProducts,
      rejectedProducts: patch.rejectedProducts ?? current.rejectedProducts,
      preferredGenres: patch.preferredGenres ?? current.preferredGenres,
      cart: patch.cart
        ? { items: patch.cart.items ?? current.cart?.items ?? [] }
        : current.cart,
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

  summarizeForPrompt(memory: CallConversationMemory): string {
    const lines: string[] = [];
    if (memory.customerName?.trim()) lines.push(`Customer name: ${memory.customerName.trim()}.`);
    if (memory.preferredGenres?.length) {
      lines.push(`Preferred genres: ${memory.preferredGenres.join(', ')}.`);
    }
    const discussed = memory.discussedProducts ?? memory.mentionedProducts ?? [];
    if (discussed.length) {
      const titles = discussed
        .slice(-5)
        .map((p) => p.title)
        .filter(Boolean)
        .join('; ');
      lines.push(`Products discussed: ${titles}.`);
    }
    if (memory.rejectedProducts?.length) {
      lines.push(
        `Rejected: ${memory.rejectedProducts
          .slice(-3)
          .map((p) => p.title)
          .join('; ')}.`,
      );
    }
    if (memory.cart?.items?.length) {
      const cartLine = memory.cart.items
        .map((i) => `${i.title}${i.quantity > 1 ? ` x${i.quantity}` : ''}`)
        .join('; ');
      lines.push(`Cart: ${cartLine}.`);
    }
    if (memory.checkoutState && memory.checkoutState !== 'none') {
      lines.push(`Checkout: ${memory.checkoutState}.`);
    }
    if (memory.collectedEmail?.trim()) {
      lines.push(`Email on file: ${memory.collectedEmail.trim()}.`);
    }
    if (memory.conversationStage) lines.push(`Conversation stage: ${memory.conversationStage}.`);
    if (memory.lastObjection) lines.push(`Last objection: ${memory.lastObjection}.`);
    return lines.length ? lines.join(' ') : 'No prior customer context this call.';
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
    product: { productId?: string; title: string; variantId?: string; price?: string },
  ): Promise<void> {
    const mem = await this.load(callSessionId);
    const entry = { ...product };
    const list = [...(mem.mentionedProducts ?? [])];
    const discussed = [...(mem.discussedProducts ?? [])];
    const push = (arr: typeof list) => {
      if (!arr.some((p) => p.title === product.title && p.productId === product.productId)) {
        arr.push(entry);
        if (arr.length > 15) arr.shift();
      }
    };
    push(list);
    push(discussed);
    await this.merge(callSessionId, { mentionedProducts: list, discussedProducts: discussed });
  }

  async recordRejected(callSessionId: string, title: string, reason?: string): Promise<void> {
    const mem = await this.load(callSessionId);
    const list = [...(mem.rejectedProducts ?? [])];
    if (!list.some((p) => p.title === title)) {
      list.push({ title, reason });
      if (list.length > 10) list.shift();
    }
    await this.merge(callSessionId, { rejectedProducts: list });
  }

  async updateCart(
    callSessionId: string,
    item: {
      productId?: string;
      title: string;
      variantId?: string;
      quantity: number;
      price?: string;
    },
  ): Promise<void> {
    const mem = await this.load(callSessionId);
    const items = [...(mem.cart?.items ?? [])];
    const idx = items.findIndex(
      (i) => i.title === item.title && i.variantId === item.variantId,
    );
    if (idx >= 0) items[idx] = { ...items[idx], ...item };
    else items.push(item);
    await this.merge(callSessionId, { cart: { items }, checkoutState: 'confirming' });
  }

  async setEmailState(
    callSessionId: string,
    email: string,
    state: 'pending' | 'confirmed',
  ): Promise<void> {
    await this.merge(callSessionId, {
      collectedEmail: email,
      emailCollected: state === 'confirmed',
      emailConfirmationState: state,
      checkoutState: state === 'confirmed' ? 'link_sent' : 'email_pending',
    });
  }
}
