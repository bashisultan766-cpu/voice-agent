import type { AdaptiveVoiceBehavior } from './adaptive-voice-behavior.util';

/** SSML-free pause hints for chunk boundaries (ms) — used by streaming orchestrator. */
export function pauseMsBetweenChunks(behavior: AdaptiveVoiceBehavior, chunkIndex: number): number {
  if (behavior.pacing === 'fast') return chunkIndex === 0 ? 80 : 120;
  if (behavior.pacing === 'slow') return chunkIndex === 0 ? 220 : 280;
  return chunkIndex === 0 ? 120 : 180;
}

/** Delay before confirmations so caller can interrupt (ms). */
export function confirmationLeadInMs(mood: AdaptiveVoiceBehavior['mood']): number {
  if (mood === 'impatient') return 0;
  if (mood === 'confused') return 400;
  return 200;
}

export function applyTimingToChunkText(text: string, behavior: AdaptiveVoiceBehavior): string {
  let t = text.trim();
  if (behavior.verbosity === 'minimal') {
    t = t.replace(/\b(um|uh|you know|basically|actually),?\s*/gi, '');
  }
  if (behavior.empathyLead && !t.toLowerCase().startsWith(behavior.empathyLead.toLowerCase().slice(0, 8))) {
    t = `${behavior.empathyLead} ${t}`;
  }
  return t.trim();
}
