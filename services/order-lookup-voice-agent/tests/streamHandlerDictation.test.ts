import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebSocket } from "ws";

import {
  abortCurrentTTS,
  applyRelayInterrupt,
  handleMediaStreamSocket,
} from "../src/voice/streamHandler.js";

import {
  createCallSession,
} from "../src/agents/conversationOrchestrator.js";

import {
  clearDictationLock,
} from "../src/runtime/dictationLock.js";

import {
  clearAllCallSessionLocks,
  clearCallSessionLock,
} from "../src/voice/callSessionLock.js";

import { clearAllStreamBarriers } from "../src/runtime/streamTurnBarrier.js";

import { clearInterruptBuffer } from "../src/runtime/interruptBuffer.js";

import type { CallSession } from "../src/types/order.js";

const CALL_SID = "CA_DICTATION_INT_TEST";
const STREAM_SID = "MZ_DICTATION_INT_TEST";

const hoisted = vi.hoisted(() => {
  let dictationStarted: (() => void) | undefined;
  let releaseDictation: (() => void) | undefined;

  const dictationReady = new Promise<void>((resolve) => {
    dictationStarted = resolve;
  });

  const dictationHold = new Promise<void>((resolve) => {
    releaseDictation = resolve;
  });

  return {
    dictationReady,
    dictationHold,
    releaseDictation: () => releaseDictation?.(),
    signalDictationStarted: () => dictationStarted?.(),
    mockProcess: vi.fn(async function* (_callSid: string, _text: string, session: CallSession) {
      yield {
        type: "chunk" as const,
        chunk: {
          text: '1<break time="800ms"/>Z<break time="800ms"/>9',
          kind: "dictation" as const,
        },
      };
      await dictationHold;
      yield { type: "done" as const, phase: session.phase };
    }),
    capturedAbort: { current: undefined as AbortSignal | undefined },
    clearCalled: { current: false },
    stopCalled: { current: false },
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

vi.mock("../src/voice/mediaStreamStt.js", () => ({
  transcribeMulawBuffer: vi.fn(async () => "yes I am ready"),
}));

vi.mock("../src/services/mediaStreamVoice.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../src/services/mediaStreamVoice.js")
  >();
  return {
    ...original,
    streamSpeechToMediaStream: vi.fn(async () => {}),
    streamChunkToMediaStream: vi.fn(
      async (
        chunk: { text: string; kind: string },
        _send: (msg: Record<string, unknown>) => void,
        options?: { abortSignal?: AbortSignal },
      ) => {
        hoisted.capturedAbort.current = options?.abortSignal;
        if (chunk.kind === "dictation") {
          hoisted.signalDictationStarted();
          await Promise.race([
            hoisted.dictationHold,
            new Promise<void>((resolve) => {
              if (options?.abortSignal?.aborted) {
                resolve();
                return;
              }
              options?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            }),
          ]);
        }
      },
    ),
    sendMediaStreamClear: vi.fn(() => {
      hoisted.clearCalled.current = true;
    }),
    sendMediaStreamStop: vi.fn(() => {
      hoisted.stopCalled.current = true;
    }),
  };
});

class MockMediaStreamSocket extends EventEmitter {
  readonly sent: unknown[] = [];

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }
}

function mediaMessage(payload: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      event: "media",
      sequenceNumber: "2",
      media: {
        track: "inbound",
        chunk: "1",
        timestamp: "100",
        payload,
      },
      streamSid: STREAM_SID,
    }),
  );
}

function mulawPayload(bytes = 200): string {
  return Buffer.alloc(bytes, 0xff).toString("base64");
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function pumpSilenceTranscription(socket: MockMediaStreamSocket): Promise<void> {
  for (let i = 0; i < 20; i++) {
    socket.emit("message", mediaMessage(mulawPayload()));
  }
  await new Promise((resolve) => setTimeout(resolve, 950));
  await flushAsyncWork();
}

describe("streamHandler dictation interrupt integration", () => {
  afterEach(() => {
    clearDictationLock(CALL_SID);
    clearCallSessionLock(CALL_SID);
    clearInterruptBuffer(CALL_SID);
    clearAllCallSessionLocks();
    clearAllStreamBarriers();
    hoisted.capturedAbort.current = undefined;
    hoisted.clearCalled.current = false;
    hoisted.stopCalled.current = false;
    hoisted.mockProcess.mockClear();
    vi.clearAllMocks();
  });

  it("applyRelayInterrupt is ignored when agent is not speaking", async () => {
    const session = createCallSession(CALL_SID, "+15550001", "+15550002");

    const result = await applyRelayInterrupt({
      getSession: () => session,
    });

    expect(result.action).toBe("ignored");
  });

  it("abortCurrentTTS sends media stream clear and stop", async () => {
    const socket = new MockMediaStreamSocket();
    void handleMediaStreamSocket(socket as unknown as WebSocket);

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          event: "start",
          sequenceNumber: "1",
          start: {
            streamSid: STREAM_SID,
            accountSid: "AC_TEST",
            callSid: CALL_SID,
            tracks: ["inbound"],
            mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
            customParameters: { from: "+15550001", to: "+15550002" },
          },
          streamSid: STREAM_SID,
        }),
      ),
    );

    await flushAsyncWork();
    await pumpSilenceTranscription(socket);
    await hoisted.dictationReady;

    const aborted = await abortCurrentTTS(CALL_SID, true);
    expect(aborted).toBe(true);
    expect(hoisted.capturedAbort.current?.aborted).toBe(true);
    expect(hoisted.clearCalled.current).toBe(true);
    expect(hoisted.stopCalled.current).toBe(true);

    hoisted.releaseDictation();
    await flushAsyncWork();
  });
});
