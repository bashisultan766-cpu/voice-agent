import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryEventStore } from "../src/platform/inMemoryEventStore.js";

describe("InMemoryEventStore", () => {
  let store: InMemoryEventStore;

  beforeEach(() => {
    store = new InMemoryEventStore();
  });

  it("appends and loads events since a turn sequence", () => {
    const callSid = "CA_mem_1";
    store.append({
      callSid,
      turnSeq: 1,
      event: { type: "TURN_INGESTED", payload: { textLength: 3 } },
    });
    store.append({
      callSid,
      turnSeq: 2,
      event: {
        type: "MEMORY_SYNCD",
        payload: { searchKey: "isbn:978", isbnPartialCleared: true },
      },
    });

    expect(store.loadSince(callSid, 1)).toHaveLength(2);
    expect(store.loadSince(callSid, 2)).toHaveLength(1);
    expect(store.loadSince("CA_other", 1)).toHaveLength(0);
  });

  it("stores memory snapshots on append", () => {
    const snapshot = {
      product: {
        isbn: "9783161484100",
        isbnCollected: true,
        titleCollected: false,
      },
      callState: {
        intent: "product" as const,
        phase: "PHASE_1" as const,
        awaitingInput: "none" as const,
        slots: {},
        slotFlags: {
          isbnCollected: true,
          titleCollected: false,
          recommendationsCollected: false,
        },
      },
    };

    const stored = store.append({
      callSid: "CA_snap",
      turnSeq: 1,
      event: { type: "MEMORY_SYNCD", payload: { searchKey: "isbn:9783161484100" } },
      memoryBefore: snapshot,
      memoryAfter: snapshot,
    });

    expect(stored.memoryBefore?.product.isbn).toBe("9783161484100");
    expect(stored.memoryAfter?.product.isbn).toBe("9783161484100");
  });

  it("clears per-call logs", () => {
    const callSid = "CA_clear";
    store.append({
      callSid,
      turnSeq: 1,
      event: { type: "TURN_INGESTED", payload: { textLength: 1 } },
    });
    store.clear(callSid);
    expect(store.loadSince(callSid, 1)).toHaveLength(0);
  });
});
