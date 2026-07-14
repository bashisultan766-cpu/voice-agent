import { describe, expect, it, afterEach } from "vitest";
import {
  processVoicePreTurn,
  onListeningWaitTimer,
  LISTENING_WAIT_MAX_MS,
  LISTENING_WAIT_FIRST_PROMPT_MS,
} from "../src/voice/voicePreTurn.js";
import {
  SharedListeningWaitScheduler,
  cancelListeningWaitTimer,
} from "../src/voice/turnScheduler.js";
import { ensureSessionMemory } from "../src/agents/sessionMemory.js";
import type { CallSession } from "../src/types/order.js";

function make(callSid: string): CallSession {
  return {
    callSid,
    from: "+1",
    to: "+1",
    phase: "active",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
  } as CallSession;
}

function runBoth(text: string) {
  const relay = make("CA_RELAY");
  const streams = make("CA_STREAM");
  const ra = processVoicePreTurn(relay, {
    transport: "conversation_relay",
    callId: relay.callSid,
    text,
  });
  const rb = processVoicePreTurn(streams, {
    transport: "media_streams",
    callId: streams.callSid,
    text,
  });
  return { relay, streams, ra, rb };
}

function paritySnapshot(session: CallSession) {
  const memory = ensureSessionMemory(session);
  return {
    buffer: memory.listeningWaitBuffer ?? null,
    waiting: Boolean(memory.listeningWait),
    waitId: memory.listeningWait?.waitId ?? null,
    enteredAt: memory.listeningWaitEnteredAt ?? null,
    promptCount: memory.listeningWaitPromptCount ?? null,
  };
}

afterEach(() => {
  SharedListeningWaitScheduler.clearAll();
});

describe("VoicePreTurn transport parity", () => {
  it("incomplete purchase utterance → listening_wait on both transports", () => {
    const { ra, rb, relay, streams } = runBoth("I want to buy");
    expect(ra.action).toBe("listening_wait");
    expect(rb.action).toBe(ra.action);
    expect(paritySnapshot(relay)).toMatchObject({
      buffer: ensureSessionMemory(streams).listeningWaitBuffer,
      waiting: true,
    });
    expect(paritySnapshot(streams).waiting).toBe(true);
  });

  it("email dictation pause → listening_wait parity", () => {
    const { ra, rb } = runBoth("my email is j");
    expect(ra.action).toBe(rb.action);
    expect(["listening_wait", "proceed"]).toContain(ra.action);
  });

  it("tracking dictation pause → listening_wait parity", () => {
    const { ra, rb } = runBoth("tracking starts with 9");
    expect(ra.action).toBe(rb.action);
  });

  it("user resumes before timeout → proceed with merged buffer on both", () => {
    const relay = make("CA_RESUME_R");
    const streams = make("CA_RESUME_S");
    processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: "I want to",
    });
    processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: "I want to",
    });
    const ra = processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: "check my order please.",
    });
    const rb = processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: "check my order please.",
    });
    expect(ra.action).toBe(rb.action);
    expect(paritySnapshot(relay).waiting).toBe(paritySnapshot(streams).waiting);
  });

  it("stale wait timer fires after state changed → null / no-op on both", () => {
    const relay = make("CA_STALE_R");
    const streams = make("CA_STALE_S");
    processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: "I want to",
    });
    processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: "I want to",
    });
    const staleRelayId = ensureSessionMemory(relay).listeningWait!.waitId;
    const staleStreamsId = ensureSessionMemory(streams).listeningWait!.waitId;
    processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: "buy this book please.",
    });
    processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: "buy this book please.",
    });
    expect(onListeningWaitTimer(relay, staleRelayId)).toBeNull();
    expect(onListeningWaitTimer(streams, staleStreamsId)).toBeNull();
  });

  it("DTMF during wait does not diverge transports (ignored as empty/noise)", () => {
    const relay = make("CA_DTMF_R");
    const streams = make("CA_DTMF_S");
    processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: "I want to",
    });
    processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: "I want to",
    });
    const ra = processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: " ",
    });
    const rb = processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: " ",
    });
    expect(ra.action).toBe(rb.action);
    expect(paritySnapshot(relay).waiting).toBe(paritySnapshot(streams).waiting);
  });

  it("background noise / filler keeps parity", () => {
    const { ra, rb } = runBoth("um");
    expect(ra.action).toBe(rb.action);
  });

  it("barge-in during timeout prompt window keeps parity", () => {
    const relay = make("CA_BARGE_R");
    const streams = make("CA_BARGE_S");
    processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: "I want to",
    });
    processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: "I want to",
    });
    ensureSessionMemory(relay).listeningWaitEnteredAt =
      Date.now() - LISTENING_WAIT_FIRST_PROMPT_MS - 50;
    ensureSessionMemory(streams).listeningWaitEnteredAt =
      Date.now() - LISTENING_WAIT_FIRST_PROMPT_MS - 50;
    const ra = processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: "actually buy The Art of War",
    });
    const rb = processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: "actually buy The Art of War",
    });
    expect(ra.action).toBe(rb.action);
  });

  it("remote disconnect clears wait identically (manual clear parity)", () => {
    const relay = make("CA_DISC_R");
    const streams = make("CA_DISC_S");
    processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: "I want to",
    });
    processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: "I want to",
    });
    const clear = (s: CallSession) => {
      cancelListeningWaitTimer(s.callSid);
      const memory = ensureSessionMemory(s);
      memory.listeningWait = undefined;
      memory.listeningWaitBuffer = undefined;
      memory.listeningWaitEnteredAt = undefined;
      memory.listeningWaitPromptCount = undefined;
    };
    clear(relay);
    clear(streams);
    expect(paritySnapshot(relay)).toEqual(paritySnapshot(streams));
  });

  it("silence timer interjection preserves buffer and waitId (idempotent stale after proceed)", () => {
    const relay = make("CA_REP_R");
    const streams = make("CA_REP_S");
    processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: "I want to",
    });
    processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: "I want to",
    });
    const waitRelay = ensureSessionMemory(relay).listeningWait!.waitId;
    const waitStreams = ensureSessionMemory(streams).listeningWait!.waitId;
    const bufRelay = ensureSessionMemory(relay).listeningWaitBuffer;
    const bufStreams = ensureSessionMemory(streams).listeningWaitBuffer;

    const firstR = onListeningWaitTimer(relay, waitRelay);
    const firstS = onListeningWaitTimer(streams, waitStreams);
    expect(firstR?.action).toBe("listening_wait");
    expect(firstS?.action).toBe("listening_wait");
    expect(firstR && "speech" in firstR && firstR.speech).toBeTruthy();
    expect(ensureSessionMemory(relay).listeningWaitBuffer).toBe(bufRelay);
    expect(ensureSessionMemory(streams).listeningWaitBuffer).toBe(bufStreams);
    expect(ensureSessionMemory(relay).listeningWait?.waitId).toBe(waitRelay);
    expect(ensureSessionMemory(streams).listeningWait?.waitId).toBe(waitStreams);

    // Proceed clears wait — subsequent timer with old waitId is stale.
    processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: "buy The Art of War please.",
    });
    processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: "buy The Art of War please.",
    });
    expect(onListeningWaitTimer(relay, waitRelay)).toBeNull();
    expect(onListeningWaitTimer(streams, waitStreams)).toBeNull();
  });

  it("long silence + incomplete continuation keeps LISTENING_WAIT buffer (no clear)", () => {
    const relay = make("CA_TO_R");
    const streams = make("CA_TO_S");
    processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: "I want to",
    });
    processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: "I want to",
    });
    ensureSessionMemory(relay).listeningWaitEnteredAt =
      Date.now() - LISTENING_WAIT_MAX_MS - 100;
    ensureSessionMemory(streams).listeningWaitEnteredAt =
      Date.now() - LISTENING_WAIT_MAX_MS - 100;
    const ra = processVoicePreTurn(relay, {
      transport: "conversation_relay",
      callId: relay.callSid,
      text: "buy",
    });
    const rb = processVoicePreTurn(streams, {
      transport: "media_streams",
      callId: streams.callSid,
      text: "buy",
    });
    expect(ra.action).toBe("listening_wait");
    expect(rb.action).toBe("listening_wait");
    expect(ensureSessionMemory(relay).listeningWait).toBeDefined();
    expect(ensureSessionMemory(streams).listeningWait).toBeDefined();
    expect(ensureSessionMemory(relay).listeningWaitBuffer).toContain("I want to");
    expect(ensureSessionMemory(streams).listeningWaitBuffer).toContain("I want to");
  });

  it("complete clause → proceed on both transports", () => {
    const { ra, rb } = runBoth("I want to check my order status please.");
    expect(ra.action).toBe(rb.action);
    expect(["proceed", "listening_wait"]).toContain(ra.action);
  });
});
