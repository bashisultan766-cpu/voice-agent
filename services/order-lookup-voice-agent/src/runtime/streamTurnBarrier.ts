/**
 * Stream-layer turn barrier — no STT/orchestrator entry without exclusive lock.
 */
import { logger } from "../utils/logger.js";
import { acquireTurnLock } from "./turnExecutionQueue.js";

interface BufferedTurn {
  work: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface PartialTranscriptState {
  chunks: string[];
}

const pendingStreamBuffer = new Map<string, BufferedTurn[]>();
const partialTranscripts = new Map<string, PartialTranscriptState>();
const draining = new Map<string, boolean>();

export function bufferPartialTranscript(callSid: string, chunk: string): void {
  const state = partialTranscripts.get(callSid) ?? { chunks: [] };
  if (chunk) state.chunks.push(chunk);
  partialTranscripts.set(callSid, state);
}

export function takeFinalTranscript(callSid: string, finalChunk: string): string {
  const state = partialTranscripts.get(callSid);
  partialTranscripts.delete(callSid);
  const parts = [...(state?.chunks ?? [])];
  if (finalChunk) parts.push(finalChunk);
  return parts.join("").trim();
}

export function clearStreamBarrier(callSid: string): void {
  pendingStreamBuffer.delete(callSid);
  partialTranscripts.delete(callSid);
  draining.delete(callSid);
}

export function getStreamBufferDepth(callSid: string): number {
  return pendingStreamBuffer.get(callSid)?.length ?? 0;
}

/** Queue a turn — acquires stream lock before work; drains FIFO per callSid. */
export function enqueueStreamTurn(callSid: string, work: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const queue = pendingStreamBuffer.get(callSid) ?? [];
    queue.push({ work, resolve, reject });
    pendingStreamBuffer.set(callSid, queue);
    void drainStreamBuffer(callSid);
  });
}

async function drainStreamBuffer(callSid: string): Promise<void> {
  if (draining.get(callSid)) return;
  draining.set(callSid, true);

  try {
    for (;;) {
      const queue = pendingStreamBuffer.get(callSid);
      if (!queue?.length) break;

      const item = queue.shift()!;
      if (queue.length === 0) pendingStreamBuffer.delete(callSid);

      logger.info("stream_lock_acquired", {
        callSid: callSid.slice(0, 8),
        queueRemaining: queue.length,
      });

      const release = await acquireTurnLock(callSid);
      try {
        logger.info("stream_buffer_drain", {
          callSid: callSid.slice(0, 8),
          queueRemaining: getStreamBufferDepth(callSid),
        });
        await item.work();
        item.resolve();
      } catch (err) {
        item.reject(err);
        throw err;
      } finally {
        release();
      }
    }
  } catch (err) {
    logger.error("stream_buffer_drain_failed", {
      callSid: callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    draining.set(callSid, false);
    if (getStreamBufferDepth(callSid) > 0) {
      void drainStreamBuffer(callSid);
    }
  }
}

export function clearAllStreamBarriers(): void {
  pendingStreamBuffer.clear();
  partialTranscripts.clear();
  draining.clear();
}
