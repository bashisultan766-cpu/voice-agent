/**
 * Benchmark realtime voice product search tiers (mocked — no Shopify/Redis required).
 * Run: pnpm benchmark:realtime-product-search
 */
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import type { ShopifyProductSummary } from '../modules/agents/shopify-agent.service';
import { BookstoreSearchCacheService } from '../modules/search/bookstore-search-cache.service';
import { BookstoreVoiceSearchService } from '../modules/search/bookstore-voice-search.service';
import { RealtimeVoiceProductSearchService } from '../modules/search/realtime/realtime-voice-product-search.service';

function product(title: string): ShopifyProductSummary {
  const id = title.replace(/\s/g, '-');
  return {
    productId: id,
    id,
    title,
    handle: title.toLowerCase(),
    vendor: 'Bench',
    status: 'ACTIVE',
    variants: [{ id: 'v1', title, sku: null, price: '12.00', inventory_quantity: 3, availableForSale: true }],
  };
}

type Scenario = {
  name: string;
  cacheHit?: boolean;
  indexHit?: boolean;
  liveMs?: number;
};

function buildBenchService(scenario: Scenario): RealtimeVoiceProductSearchService {
  const cache = {
    lookupParallel: async () =>
      scenario.cacheHit
        ? {
            memory: { ok: true, products: [product('Cached Title')] },
            redis: null,
            memoryHit: true,
            redisHit: false,
            cacheLookupMs: 2,
          }
        : { memory: null, redis: null, memoryHit: false, redisHit: false, cacheLookupMs: 2 },
    recordPopularSearch: async () => undefined,
    setMemory: () => undefined,
    setRedis: async () => undefined,
  } as unknown as BookstoreSearchCacheService;

  const voiceSearch = {
    searchIndexedOnly: async () =>
      scenario.indexHit
        ? { ok: true, products: [product('Indexed Title')], searchVoiceLog: { topScore: 900 } }
        : { ok: false, products: [], searchVoiceLog: { topScore: 0 } },
  } as unknown as BookstoreVoiceSearchService;

  const shopifyAgent = {
    searchProducts: async () => {
      if (scenario.liveMs) await new Promise((r) => setTimeout(r, scenario.liveMs));
      return { ok: true, products: [product('Live Title')] };
    },
  } as never;

  const config = { get: () => undefined } as unknown as ConfigService;
  return new RealtimeVoiceProductSearchService(config, cache, voiceSearch, shopifyAgent);
}

async function runScenario(scenario: Scenario, iterations = 40): Promise<{ avgMs: number; p95Ms: number }> {
  const svc = buildBenchService(scenario);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await svc.search('bench_tenant', 'bench_agent', 'Atomic Habits');
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const avgMs = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p95Ms = samples[Math.floor(samples.length * 0.95)] ?? avgMs;
  return { avgMs, p95Ms };
}

async function main(): Promise<void> {
  const cacheAfter = await runScenario({ name: 'cache_hit', cacheHit: true }, 40);
  const indexAfter = await runScenario({ name: 'postgres_index', indexHit: true }, 40);
  const timeoutAfter = await runScenario({ name: 'live_timeout_capped', liveMs: 2000 }, 8);
  const uncappedLiveMs = 1200;

  console.log('\n=== Realtime Voice Product Search Benchmark (mocked) ===\n');
  console.log(
    JSON.stringify(
      {
        before: {
          label: 'Uncapped live Shopify (estimated)',
          avgMs: uncappedLiveMs,
          p95Ms: uncappedLiveMs,
        },
        after: {
          cacheHit: { avgMs: Math.round(cacheAfter.avgMs), p95Ms: Math.round(cacheAfter.p95Ms) },
          postgresIndex: { avgMs: Math.round(indexAfter.avgMs), p95Ms: Math.round(indexAfter.p95Ms) },
          cappedLiveTimeout: { avgMs: Math.round(timeoutAfter.avgMs), p95Ms: Math.round(timeoutAfter.p95Ms) },
        },
        deadlineMs: 800,
        improvementCacheVsLive: `${Math.round((1 - cacheAfter.avgMs / uncappedLiveMs) * 100)}% faster avg`,
        improvementIndexVsLive: `${Math.round((1 - indexAfter.avgMs / uncappedLiveMs) * 100)}% faster avg`,
      },
      null,
      2,
    ),
  );
}

void main();
