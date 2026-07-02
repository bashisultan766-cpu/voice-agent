import { describe, it, expect } from "vitest";
import { streamAgentTurn, createCallSession } from "../src/agents/orderAgent.js";

describe("streaming agent", () => {
  it("yields filler before lookup completes for order number input", async () => {
    const session = createCallSession("CA555", "+1", "+2");
    session.phase = "awaiting_order_number";

    const events = [];
    for await (const event of streamAgentTurn(session, "order number 45678")) {
      events.push(event);
    }

    const firstChunk = events.find((e) => e.type === "chunk");
    expect(firstChunk).toBeDefined();
    if (firstChunk?.type === "chunk") {
      expect(firstChunk.chunk.kind).toBe("filler");
    }
  });

  it("handles invalid order with error chunk", async () => {
    const session = createCallSession("CA123", "+15550001", "+15550002");
    session.phase = "awaiting_order_number";

    const chunks: string[] = [];
    for await (const event of streamAgentTurn(session, "hello there")) {
      if (event.type === "chunk") chunks.push(event.chunk.text);
    }

    expect(chunks.join(" ")).toMatch(/valid order number|didn't catch/i);
    expect(session.phase).toBe("awaiting_order_number");
  });
});
