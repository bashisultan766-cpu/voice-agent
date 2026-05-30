import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import type { ShopifyProductSummary } from '../../agents/shopify-agent.service';
import { BookstoreSearchCacheService } from '../bookstore-search-cache.service';
import { BookstoreVoiceSearchService } from '../bookstore-voice-search.service';
import {
  REALTIME_SLOW_SEARCH_FILLER,
  REALTIME_VOICE_SEARCH_DEADLINE_MS,
  RealtimeVoiceProductSearchService,
} from '../realtime/realtime-voice-product-search.service';
import { parseRealtimeSearchQuery } from '../realtime/realtime-search-query.util';
import { ConversationAgent } from '../../realtime-voice/agents/conversation.agent';
import type { VoiceGraphState } from '../../realtime-voice/types/voice-turn.types';

function product(
  title: string,
  opts: { id?: string; price?: string; inStock?: boolean; score?: number } = {},
): ShopifyProductSummary {
  const id = opts.id ?? title.replace(/\s/g, '-');
  return {
    productId: id,
    id,
    title,
    handle: title.toLowerCase().replace(/\s/g, '-'),
    vendor: 'Test Author',
    status: 'ACTIVE',
    variants: [
      {
        id: 'v1',
        title,
        sku: null,
        price: opts.price ?? '19.99',
        inventory_quantity: opts.inStock === false ? 0 : 5,
        availableForSale: opts.inStock !== false,
      },
    ],
    relevanceScore: opts.score ?? 800,
    matchReason: 'test',
  };
}

function indexHit(...products: ShopifyProductSummary[]) {
  return {
    ok: true,
    products,
    searchVoiceLog: { topScore: products[0]?.relevanceScore ?? 900 },
  } as never;
}

function indexMiss() {
  return { ok: false, products: [], searchVoiceLog: { topScore: 0 } } as never;
}

function buildService(mocks: {
  cache?: Partial<BookstoreSearchCacheService>;
  voiceSearch?: { searchIndexedOnly?: (...args: unknown[]) => Promise<unknown> };
  shopifyAgent?: { searchProducts: (...args: unknown[]) => Promise<unknown> };
  deadlineMs?: number;
}): RealtimeVoiceProductSearchService {
  const cache = {
    lookupParallel: async () => ({ memory: null, redis: null, memoryHit: false, redisHit: false, cacheLookupMs: 1 }),
    recordPopularSearch: async () => undefined,
    setMemory: () => undefined,
    setRedis: async () => undefined,
    ...mocks.cache,
  } as unknown as BookstoreSearchCacheService;

  const voiceSearch = {
    searchIndexedOnly: mocks.voiceSearch?.searchIndexedOnly ?? (async () => ({ ok: false, products: [] })),
  } as unknown as BookstoreVoiceSearchService;

  const shopifyAgent = {
    searchProducts: mocks.shopifyAgent?.searchProducts ?? (async () => ({ ok: true, products: [] })),
  } as never;

  const config = {
    get: (key: string) => (key === 'REALTIME_VOICE_SEARCH_DEADLINE_MS' ? mocks.deadlineMs : undefined),
  } as ConfigService;

  return new RealtimeVoiceProductSearchService(config, cache, voiceSearch, shopifyAgent);
}

test('parseRealtimeSearchQuery detects ISBN and title typo variants', () => {
  const isbn = parseRealtimeSearchQuery('Do you have ISBN 978-0316769174');
  assert.equal(isbn.kind, 'isbn');
  assert.equal(isbn.isbn, '9780316769174');
  assert.ok(isbn.typoVariants.length >= 1);

  const typo = parseRealtimeSearchQuery('Harry Poter and the sorcerers stone');
  assert.equal(typo.kind, 'title');
  assert.ok(typo.typoVariants.some((v) => v.includes('harry')));
});

test('title search returns postgres index hit under deadline', async () => {
  const svc = buildService({
    voiceSearch: {
      searchIndexedOnly: async () => indexHit(product('Atomic Habits', { score: 900 })),
    },
    shopifyAgent: {
      searchProducts: async () => {
        throw new Error('Shopify live must not be called');
      },
    },
  });

  const result = await svc.search('tenant', 'agent', 'Atomic Habits');
  assert.equal(result.source, 'postgres_index');
  assert.equal(result.products[0]!.title, 'Atomic Habits');
  assert.equal(result.slowSearchFiller, false);
  assert.ok(result.latencyMs <= REALTIME_VOICE_SEARCH_DEADLINE_MS + 50);
});

test('ISBN search uses index then live fallback', async () => {
  let liveCalled = false;
  const svc = buildService({
    voiceSearch: {
      searchIndexedOnly: async () => indexMiss(),
    },
    shopifyAgent: {
      searchProducts: async () => {
        liveCalled = true;
        return {
          ok: true,
          products: [product('The Catcher in the Rye', { id: 'isbn-book' })],
          voiceSummary: 'Found by ISBN',
        };
      },
    },
  });

  const result = await svc.search('tenant', 'agent', '9780316769174');
  assert.equal(result.queryKind, 'isbn');
  assert.ok(liveCalled);
  assert.equal(result.source, 'shopify_live');
  assert.equal(result.products.length, 1);
});

test('spoken typo search checks cache typo variants', async () => {
  const lookups: string[] = [];
  const svc = buildService({
    cache: {
      lookupParallel: async (_t, _a, q) => {
        lookups.push(q);
        if (q.includes('atomik') || q.includes('atomic')) {
          return {
            memory: { ok: true, products: [product('Atomic Habits')] },
            redis: null,
            memoryHit: true,
            redisHit: false,
            cacheLookupMs: 2,
          };
        }
        return { memory: null, redis: null, memoryHit: false, redisHit: false, cacheLookupMs: 2 };
      },
    },
    shopifyAgent: {
      searchProducts: async () => {
        throw new Error('should hit cache');
      },
    },
  });

  const result = await svc.search('tenant', 'agent', 'Atomik Habits');
  assert.equal(result.cacheHit, true);
  assert.equal(result.source, 'memory_cache');
  assert.ok(lookups.length >= 1);
});

test('cache hit returns instantly from redis', async () => {
  const svc = buildService({
    cache: {
      lookupParallel: async () => ({
        memory: null,
        redis: { ok: true, products: [product('Dark Tower')] },
        memoryHit: false,
        redisHit: true,
        cacheLookupMs: 3,
      }),
    },
    shopifyAgent: {
      searchProducts: async () => {
        throw new Error('cache hit should skip shopify');
      },
    },
  });

  const result = await svc.search('tenant', 'agent', 'Dark Tower');
  assert.equal(result.source, 'redis_cache');
  assert.equal(result.cacheHit, true);
  assert.ok(result.latencyMs < 100);
});

test('cache miss falls through to index and live', async () => {
  const stages: string[] = [];
  const svc = buildService({
    cache: {
      lookupParallel: async () => {
        stages.push('cache');
        return { memory: null, redis: null, memoryHit: false, redisHit: false, cacheLookupMs: 1 };
      },
    },
    voiceSearch: {
      searchIndexedOnly: async () => {
        stages.push('index');
        return indexMiss();
      },
    },
    shopifyAgent: {
      searchProducts: async () => {
        stages.push('live');
        return { ok: true, products: [product('Mystery Book')] };
      },
    },
  });

  await svc.search('tenant', 'agent', 'Mystery Book');
  assert.deepEqual(stages, ['cache', 'index', 'live']);
});

test('shopify timeout returns slow search filler within deadline', async () => {
  const svc = buildService({
    deadlineMs: 120,
    voiceSearch: {
      searchIndexedOnly: async () => indexMiss(),
    },
    shopifyAgent: {
      searchProducts: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { ok: true, products: [product('Late Book')] };
      },
    },
  });

  const result = await svc.search('tenant', 'agent', 'Late Book');
  assert.equal(result.slowSearchFiller, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.voiceSummary, REALTIME_SLOW_SEARCH_FILLER);
  assert.ok(result.latencyMs <= 250);
});

test('multiple product matches return ranked list', async () => {
  const svc = buildService({
    voiceSearch: {
      searchIndexedOnly: async () =>
        indexHit(
          product('Harry Potter 1', { score: 820 }),
          product('Harry Potter 2', { score: 810 }),
          product('Harry Potter 3', { score: 800 }),
        ),
    },
  });

  const result = await svc.search('tenant', 'agent', 'Harry Potter');
  assert.equal(result.matchCount, 3);
  assert.equal(result.products.length, 3);
});

test('out of stock product is surfaced with stock flag in conversation', () => {
  const agent = new ConversationAgent();
  const state = {
    intent: 'product_search',
    utterance: 'Atomic Habits',
    agentResults: [
      {
        agent: 'shopify_search',
        ok: true,
        data: {
          products: [{ title: 'Atomic Habits', price: '$18.00', inStock: false }],
        },
      },
    ],
    context: { agent: { name: 'Books' }, tenantId: 't', agentId: 'a', callSessionId: 'c' },
  } as VoiceGraphState;

  const { reply } = agent.synthesize(state);
  assert.match(reply!, /out of stock/i);
  assert.match(reply!, /checkout link/i);
});

test('payment link product handoff mentions checkout after product match', () => {
  const agent = new ConversationAgent();
  const state = {
    intent: 'checkout',
    utterance: 'send me the link',
    agentResults: [
      {
        agent: 'shopify_search',
        ok: true,
        data: { products: [{ title: 'Rich Dad Poor Dad', price: '$15.00', inStock: true, id: 'rdpd' }] },
      },
      {
        agent: 'payment_link',
        ok: true,
        data: { checkoutUrl: 'https://checkout.test/abc', sent: true },
      },
    ],
    context: { agent: { name: 'Books' }, tenantId: 't', agentId: 'a', callSessionId: 'c' },
  } as VoiceGraphState;

  const { reply } = agent.synthesize(state);
  assert.match(reply!, /checkout link/i);
  assert.match(reply!, /email/i);
});
