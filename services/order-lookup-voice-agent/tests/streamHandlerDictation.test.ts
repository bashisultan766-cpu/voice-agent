import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  applyRelayInterrupt,
  handleConversationRelaySocket,
} from "../src/voice/streamHandler.js";
import { createCallSession } from "../src/agents/conversationOrchestrator.js";
import {
  clearDictationLock,
  enterDictationLock,
  isDictationLocked,
} from "../src/runtime/dictationLock.js";
import {
  clearAllCallSessionLocks,
  clearCallSessionLock,
} from "../src/voice/callSessionLock.js";
import { clearAllStreamBarriers } from "../src/runtime/streamTurnBarrier.js";
import type { CallSession } from "../src/types/order.js";

const CALL_SID = "CA_DICTATION_INT_TEST";

const hoisted = vi.hoisted(() => {
  let dictationStarted: (() => void) | undefined;
  const dictationReady = new Promise<void>((resolve) => {
    dictationStarted = resolve;
  });

  return {
    dictationReady,
    signalDictationStarted: () => dictationStarted?.(),
    mockProcess: vi.fn(async function* (_callSid: string, _text: string, session: CallSession) {
      yield {
        type: "chunk" as const,
        chunk: {
          text: '1<break time="800ms"/>Z<break time="800ms"/>9',
          kind: "dictation" as const,
        },
      };
      dictationStarted?.();
      await new Promise((resolve) => setTimeout(resolve, 150));
      yield { type: "done" as const, phase: session.phase };
    }),
    capturedAbort: { current: undefined as AbortSignal | undefined },
    finalizeCalled: { current: false },
  };
});

vi.mock("../src/agents/conversationOrchestrator.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../src/agents/conversationOrchestrator.js")
  >();
  return {
    ...original,
    process: hoisted.mockProcess,
    endCallSession: vi.fn(),
  };
});

vi.mock("../src/runtime/streamTurnBarrier.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../src/runtime/streamTurnBarrier.js")
  >();
  return {
    ...original,
    enqueueStreamTurn: (_callSid: string, work: () => Promise<void>) => work(),
  };
});

vi.mock("../src/services/voiceService.js", () => ({
  streamOneChunkToRelay: vi.fn(
    async (
      chunk: { text: string; kind: string },
      send: (msg: Record<string, unknown>) => Promise<void>,
      _isLast: boolean,
      options?: { abortSignal?: AbortSignal },
    ) => {
      hoisted.capturedAbort.current = options?.abortSignal;
      await send({
        type: "text",
        token: chunk.text,
        last: false,
        interruptible: chunk.kind !== "dictation",
      });
    },
  ),
  finalizeRelayStream: vi.fn(async (send: (msg: Record<string, unknown>) => Promise<void>) => {
    hoisted.finalizeCalled.current = true;
    await send({ type: "text", token: "", last: true });
  }),
}));

vi.mock("../src/adapters/ttsAdapter.js", () => ({
  logTtsEngineSelection: vi.fn(),
  getElevenLabsVoiceSettings: vi.fn(() => ({
    stability: 0.7,
    similarity_boost: 0.85,
    style: 0,
    use_speaker_boost: true,
  })),
}));

class MockRelaySocket extends EventEmitter {
  readonly sent: unknown[] = [];

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }
}

function relayMessage(payload: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("streamHandler dictation interrupt integration", () => {
  afterEach(() => {
    clearDictationLock(CALL_SID);
    clearCallSessionLock(CALL_SID);
    clearAllCallSessionLocks();
    clearAllStreamBarriers();
    hoisted.capturedAbort.current = undefined;
    hoisted.finalizeCalled.current = false;
    hoisted.mockProcess.mockClear();
  });

  it("applyRelayInterrupt suppresses abort while dictation lock is active", () => {
    const session = createCallSession(CALL_SID, "+15550001", "+15550002");
    const abort = new AbortController();
    enterDictationLock(CALL_SID);

    const result = applyRelayInterrupt({
      getSession: () => session,
      getTurnAbort: () => abort,
    });

    expect(result.action).toBe("suppressed");
    expect(abort.signal.aborted).toBe(false);
    expect(isDictationLocked(CALL_SID)).toBe(true);
  });

  it("applyRelayInterrupt aborts an in-flight turn when dictation lock is not held", () => {
    const session = createCallSession(CALL_SID, "+15550001", "+15550002");
    const abort = new AbortController();

    const result = applyRelayInterrupt({
      getSession: () => session,
      getTurnAbort: () => abort,
    });

    expect(result.action).toBe("aborted");
    expect(abort.signal.aborted).toBe(true);
  });

  it("ignores Twilio interrupt during tracking dictation and completes the relay stream", async () => {
    const socket = new MockRelaySocket();
    void handleConversationRelaySocket(socket as unknown as WebSocket);

    socket.emit(
      "message",
      relayMessage({
        type: "setup",
        callSid: CALL_SID,
        from: "+15550001",
        to: "+15550002",
      }),
    );
    await flushAsyncWork();

    socket.emit(
      "message",
      relayMessage({
        type: "prompt",
        last: true,
        voicePrompt: "yes I am ready",
      }),
    );

    await hoisted.dictationReady;
    expect(isDictationLocked(CALL_SID)).toBe(true);
    expect(hoisted.capturedAbort.current?.aborted).toBe(false);

    socket.emit("message", relayMessage({ type: "interrupt" }));
    await flushAsyncWork();

    expect(hoisted.capturedAbort.current?.aborted).toBe(false);

    const deadline = Date.now() + 3000;
    while (!hoisted.finalizeCalled.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(hoisted.finalizeCalled.current).toBe(true);
    await flushAsyncWork();
    expect(hoisted.mockProcess).toHaveBeenCalled();
    expect(isDictationLocked(CALL_SID)).toBe(false);

    const textTokens = socket.sent.filter(
      (msg) => (msg as { type?: string }).type === "text" && (msg as { token?: string }).token,
    );
    expect(textTokens.length).toBeGreaterThan(0);
    expect(JSON.stringify(textTokens)).toContain("<break time=");
  });
});
