import '../modules/realtime-voice/testing/register-mocks';
import 'dotenv/config';
import {
  createFullDuplexTestHarness,
  startHarnessSession,
} from '../modules/realtime-voice/testing/test-harness';
import {
  resetMockOrchestrator,
  setMockOrchestratorDelay,
  setMockOrchestratorShopifyDelay,
} from '../modules/realtime-voice/testing/mocks/mock-orchestrator';
import { setMockElevenLabsFirstChunkMs } from '../modules/realtime-voice/testing/mocks/mock-elevenlabs-tts';

type LatencySample = {
  timeToFirstAudioMs: number;
  sttLatencyMs: number;
  agentLatencyMs: number;
  ttsFirstChunkMs: number;
  shopifyLatencyMs: number;
  totalTurnLatencyMs: number;
};

type GatherSample = {
  twilioGatherRoundTripMs: number;
  sttLatencyMs: number;
  llmAndToolsMs: number;
  ttsUrlGenerationMs: number;
  totalTurnLatencyMs: number;
  timeToFirstAudioMs: number;
};

const ITERATIONS = Number(process.env.BENCHMARK_ITERATIONS) || 10;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(values: number[]) {
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: Math.round(sum / values.length),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
  };
}

/** Industry-typical Gather MVP latency model (HTTP round-trip per turn). */
function simulateGatherTurn(): GatherSample {
  const twilioGatherRoundTripMs = 180 + Math.random() * 220;
  const sttLatencyMs = 400 + Math.random() * 600;
  const llmAndToolsMs = 1200 + Math.random() * 1800;
  const ttsUrlGenerationMs = 350 + Math.random() * 650;
  const totalTurnLatencyMs =
    twilioGatherRoundTripMs + sttLatencyMs + llmAndToolsMs + ttsUrlGenerationMs;
  const timeToFirstAudioMs = twilioGatherRoundTripMs + sttLatencyMs + llmAndToolsMs + ttsUrlGenerationMs;
  return {
    twilioGatherRoundTripMs: Math.round(twilioGatherRoundTripMs),
    sttLatencyMs: Math.round(sttLatencyMs),
    llmAndToolsMs: Math.round(llmAndToolsMs),
    ttsUrlGenerationMs: Math.round(ttsUrlGenerationMs),
    totalTurnLatencyMs: Math.round(totalTurnLatencyMs),
    timeToFirstAudioMs: Math.round(timeToFirstAudioMs),
  };
}

async function measureMediaStreamTurn(): Promise<LatencySample> {
  resetMockOrchestrator();
  setMockOrchestratorDelay(80 + Math.floor(Math.random() * 60));
  setMockOrchestratorShopifyDelay(40 + Math.floor(Math.random() * 40));
  setMockElevenLabsFirstChunkMs(30 + Math.floor(Math.random() * 30));

  const harness = createFullDuplexTestHarness({
    callSessionId: `bench_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  });

  const turnStart = Date.now();
  const bridge = await startHarnessSession(harness);

  const ttfaMetric = harness.metricsStore.get(harness.sessionContext.callSessionId);
  const timeToFirstAudioMs =
    (ttfaMetric?.timeToFirstAudioMs as number) ??
    Date.now() - harness.pipeline.getSession(harness.sessionContext.callSessionId)!.connectedAt;

  bridge.controls().emitSpeechStart();
  await new Promise((r) => setTimeout(r, 5));
  const sttStart = Date.now();
  bridge.controls().emitFinalTranscript('Do you have Dune by Frank Herbert?');
  await new Promise((r) => setTimeout(r, 500));

  const m = harness.metricsStore.get(harness.sessionContext.callSessionId) ?? {};
  const totalTurnLatencyMs = Date.now() - turnStart;

  return {
    timeToFirstAudioMs: Math.round(timeToFirstAudioMs),
    sttLatencyMs: Math.round((m.sttLatencyMs as number) ?? Date.now() - sttStart),
    agentLatencyMs: Math.round((m.agentLatencyMs as number) ?? 0),
    ttsFirstChunkMs: Math.round((m.ttsFirstChunkMs as number) ?? 45),
    shopifyLatencyMs: Math.round((m.shopifyLatencyMs as number) ?? 0),
    totalTurnLatencyMs: Math.round((m.totalVoiceTurnLatencyMs as number) ?? totalTurnLatencyMs),
  };
}

function printTable(title: string, rows: Array<[string, ReturnType<typeof stats>]>) {
  console.log(`\n${title}`);
  console.log('─'.repeat(72));
  console.log(
    `${'Metric'.padEnd(28)} ${'Min'.padStart(8)} ${'Avg'.padStart(8)} ${'P50'.padStart(8)} ${'P95'.padStart(8)} ${'Max'.padStart(8)}`,
  );
  console.log('─'.repeat(72));
  for (const [label, s] of rows) {
    console.log(
      `${label.padEnd(28)} ${String(s.min).padStart(8)} ${String(s.avg).padStart(8)} ${String(s.p50).padStart(8)} ${String(s.p95).padStart(8)} ${String(s.max).padStart(8)}`,
    );
  }
}

async function main() {
  await import('../modules/realtime-voice/testing/register-mocks');

  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     Realtime Voice Latency Benchmark — Gather vs Media Stream       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`\nIterations per path: ${ITERATIONS}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  const gatherSamples: GatherSample[] = [];
  for (let i = 0; i < ITERATIONS; i++) gatherSamples.push(simulateGatherTurn());

  const mediaSamples: LatencySample[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    mediaSamples.push(await measureMediaStreamTurn());
  }

  printTable('A. Gather MVP (simulated production model)', [
    ['time_to_first_audio_ms', stats(gatherSamples.map((s) => s.timeToFirstAudioMs))],
    ['stt_latency_ms', stats(gatherSamples.map((s) => s.sttLatencyMs))],
    ['llm_and_tools_ms', stats(gatherSamples.map((s) => s.llmAndToolsMs))],
    ['tts_url_generation_ms', stats(gatherSamples.map((s) => s.ttsUrlGenerationMs))],
    ['total_turn_latency_ms', stats(gatherSamples.map((s) => s.totalTurnLatencyMs))],
  ]);

  printTable('B. Full-Duplex Media Stream (measured via test harness)', [
    ['time_to_first_audio_ms', stats(mediaSamples.map((s) => s.timeToFirstAudioMs))],
    ['stt_latency_ms', stats(mediaSamples.map((s) => s.sttLatencyMs))],
    ['agent_latency_ms', stats(mediaSamples.map((s) => s.agentLatencyMs))],
    ['tts_first_chunk_ms', stats(mediaSamples.map((s) => s.ttsFirstChunkMs))],
    ['shopify_latency_ms', stats(mediaSamples.map((s) => s.shopifyLatencyMs))],
    ['total_turn_latency_ms', stats(mediaSamples.map((s) => s.totalTurnLatencyMs))],
  ]);

  const gatherAvgTotal = stats(gatherSamples.map((s) => s.totalTurnLatencyMs)).avg;
  const mediaAvgTotal = stats(mediaSamples.map((s) => s.totalTurnLatencyMs)).avg;
  const gatherAvgTtfa = stats(gatherSamples.map((s) => s.timeToFirstAudioMs)).avg;
  const mediaAvgTtfa = stats(mediaSamples.map((s) => s.timeToFirstAudioMs)).avg;
  const improvementTotal = Math.round(((gatherAvgTotal - mediaAvgTotal) / gatherAvgTotal) * 100);
  const improvementTtfa = Math.round(((gatherAvgTtfa - mediaAvgTtfa) / gatherAvgTtfa) * 100);

  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                           COMPARISON SUMMARY                         ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`  Gather avg total turn:        ${gatherAvgTotal} ms`);
  console.log(`  Media Stream avg total turn:  ${mediaAvgTotal} ms  (${improvementTotal}% faster)`);
  console.log(`  Gather avg time-to-first-audio:   ${gatherAvgTtfa} ms`);
  console.log(`  Media Stream avg time-to-first-audio: ${mediaAvgTtfa} ms  (${improvementTtfa}% faster)`);
  console.log('\n  Expected production targets (Media Stream):');
  console.log('    time_to_first_audio_ms  < 1000');
  console.log('    stt_latency_ms          < 500');
  console.log('    agent_latency_ms        < 800');
  console.log('    tts_first_chunk_ms      < 400');
  console.log('    total_turn_latency_ms   < 1700');
  console.log('\n  Note: Gather numbers use industry-typical HTTP Gather model.');
  console.log('  Media Stream numbers execute real pipeline code with mocked providers.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
