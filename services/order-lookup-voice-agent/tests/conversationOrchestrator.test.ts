import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyOrchestratorIntent,
  process,
  runOrchestratorTurn,
} from "../src/agents/conversationOrchestrator.js";
import { createCallSession } from "../src/agents/orderAgent.js";
import { clearAllCallMemories } from "../src/memory/callMemoryStore.js";
import { clearAllCallStates, getOrCreateCallState } from "../src/memory/callStateStore.js";
import { mockLiveShopifyFetch } from "./helpers/mockLiveShopify.js";
import { useLlmAgentMock } from "./helpers/registerLlmMock.js";
import type { StructuredProduct } from "../src/types/product.js";
import { resetShopifyScopeCheck } from "../src/tools/shopifyScopeCheck.js";
import { resetToolExecutionGuard } from "../src/guards/toolExecutionGuard.js";
import { resetToolAccessGuard } from "../src/guards/toolAccessGuard.js";
import { enablePipelineGuardForTests, resetPipelineGuard } from "../src/guards/pipelineGuard.js";
import { resetShopifyCircuitBreaker } from "../src/platform/circuitBreaker.js";
import * as shopifyStorefrontAdapter from "../src/adapters/shopifyStorefrontAdapter.js";
import { clearAllTurnQueues } from "../src/runtime/turnExecutionQueue.js";
import { clearAllStreamBarriers } from "../src/runtime/streamTurnBarrier.js";
import { clearAllTurnHealth } from "../src/runtime/turnHealthMonitor.js";
import { clearAllCallEventSessions, loadCallEventsSince } from "../src/platform/eventDispatcher.js";

const mockCatalog: StructuredProduct[] = [
  {
    id: "1",
    title: "Harry Potter and the Prisoner of Azkaban",
    handle: "hp-azkaban",
    productType: "Book",
    vendor: "J.K. Rowling",
    tags: ["fiction", "inmates"],
    isbns: ["9783161484100"],
    variants: [
      {
        id: "10",
        sku: "9783161484100",
        barcode: "9783161484100",
        price: "14.99",
        inStock: true,
        inventoryQuantity: 4,
      },
    ],
  },
  {
    id: "2",
    title: "Inmate Reading Guide",
    handle: "guide",
    productType: "Book",
    vendor: "SureShot",
    tags: ["books", "inmates"],
    variants: [{ id: "11", price: "9.99", inStock: true, inventoryQuantity: 10 }],
  },
];

async function collectSpeech(
  session: ReturnType<typeof createCallSession>,
  text: string,
): Promise<string> {
  const parts: string[] = [];
  for await (const event of runOrchestratorTurn(session, text)) {
    if (event.type === "chunk") parts.push(event.chunk.text);
  }
  return parts.join(" ");
}

useLlmAgentMock();

describe("conversationOrchestrator intents", () => {
  it('classifies "hi" as greeting', () => {
    expect(classifyOrchestratorIntent("hi")).toBe("greeting");
  });

  it('classifies "where is my order" as order_status', () => {
    expect(classifyOrchestratorIntent("where is my order")).toBe("order_status");
  });

  it('classifies "Harry Potter book" as product_search', () => {
    expect(classifyOrchestratorIntent("I want Harry Potter book")).toBe("product_search");
  });

  it('classifies ISBN as product_search', () => {
    expect(classifyOrchestratorIntent("ISBN 9783161484100")).toBe("product_search");
  });

  it('classifies purchase intent', () => {
    expect(classifyOrchestratorIntent("I want to buy a book")).toBe("product_purchase_intent");
  });
});

describe("conversationOrchestrator flows", () => {
  beforeEach(() => {
    clearAllCallMemories();
    clearAllCallStates();
    clearAllTurnQueues();
    clearAllStreamBarriers();
    clearAllTurnHealth();
    clearAllCallEventSessions();
    resetShopifyScopeCheck();
    resetToolExecutionGuard();
    resetToolAccessGuard();
    resetPipelineGuard();
    enablePipelineGuardForTests(true);
    resetShopifyCircuitBreaker();
    vi.unstubAllGlobals();
    mockLiveShopifyFetch(mockCatalog);
  });

  it('greets naturally on "hello" without order-number demand', async () => {
    const session = createCallSession("CA_ORCH", "+1", "+2");
    const speech = await collectSpeech(session, "hello");
    expect(speech).toMatch(/SureShot Bookstore|assist you today/i);
    expect(speech).not.toMatch(/valid order number|didn't catch/i);
  });

  it("asks for order number on order status", async () => {
    const session = createCallSession("CA_ORD", "+1", "+2");
    const speech = await collectSpeech(session, "where is my order");
    expect(speech).toMatch(/order number/i);
    expect(session.awaitingInput).toBeNull();
  });

  it('Phase 1: "I need a book" asks for ISBN or title without Shopify', async () => {
    const isbnSpy = vi.spyOn(shopifyStorefrontAdapter, "searchByISBN");
    const titleSpy = vi.spyOn(shopifyStorefrontAdapter, "searchByTitle");

    const session = createCallSession("CA_NEED", "+1", "+2");
    const speech = await collectSpeech(session, "I need a book");

    expect(speech).toMatch(/title|ISBN|recommendations/i);
    expect(isbnSpy).not.toHaveBeenCalled();
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it('Phase 1: "Harry Potter book" asks clarification before Shopify', async () => {
    const titleSpy = vi.spyOn(shopifyStorefrontAdapter, "searchByTitle");

    const session = createCallSession("CA_HP", "+1", "+2");
    const speech = await collectSpeech(session, "I want Harry Potter book");

    expect(speech).toMatch(/ISBN|title|recommend/i);
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it("Phase 2: searches Harry Potter after title collection", async () => {
    const session = createCallSession("CA_HP2", "+1", "+2");
    await collectSpeech(session, "I want a book");
    await collectSpeech(session, "I have a title");
    const speech = await collectSpeech(session, "Harry Potter");
    expect(speech).toMatch(/Harry Potter|Azkaban/i);
    expect(speech).not.toMatch(/let me search|I will check/i);
  });

  it("Phase 2: looks up ISBN after slot collection", async () => {
    const session = createCallSession("CA_ISBN", "+1", "+2");
    await collectSpeech(session, "I need a book");
    await collectSpeech(session, "I have an ISBN");
    const speech = await collectSpeech(session, "9783161484100");
    expect(speech).toMatch(/Azkaban/i);
    expect(speech).not.toMatch(/let me search|I will check/i);
  });

  it("process() parses ISBN from natural speech without card redaction", async () => {
    const session = createCallSession("CA_PROC", "+1", "+2");
    const collectViaProcess = async (text: string) => {
      const parts: string[] = [];
      for await (const event of process(session.callSid, text, session)) {
        if (event.type === "chunk") parts.push(event.chunk.text);
      }
      return parts.join(" ");
    };

    await collectViaProcess("I need a book");
    await collectViaProcess("I have an ISBN");
    const speech = await collectViaProcess("The ISBN number is 9783161484100");
    expect(speech).toMatch(/Azkaban/i);
    expect(getOrCreateCallState(session.callSid).awaitingInput).toBe("none");
  });

  it("persists call state: book ask then ISBN search", async () => {
    const session = createCallSession("CA_STATE", "+1", "+2");
    const askSpeech = await collectSpeech(session, "I need a book");
    expect(askSpeech).toMatch(/ISBN|title/i);

    await collectSpeech(session, "I have an ISBN");
    const searchSpeech = await collectSpeech(session, "9783161484100");
    expect(searchSpeech).toMatch(/Azkaban|found/i);

    const stateAfterSearch = getOrCreateCallState(session.callSid);
    expect(stateAfterSearch.slots.isbn).toBe("9783161484100");
  });

  it("captures lifecycle events during process() ISBN flow", async () => {
    const session = createCallSession("CA_EVENTS", "+1", "+2");
    const drain = async (text: string) => {
      for await (const _ of process(session.callSid, text, session)) {
        /* consume stream */
      }
    };

    await drain("I need a book");
    await drain("I have an ISBN");
    await drain("9783161484100");

    const events = loadCallEventsSince(session.callSid, 1).map((row) => row.eventType);
    expect(events).toContain("TURN_INGESTED");
    expect(events).toContain("MEMORY_SYNCD");
    expect(events).toContain("TOOL_SELECTED");
    expect(events).toContain("TOOL_EXECUTION_STARTED");
    expect(events).toContain("TOOL_EXECUTION_COMPLETED");
    expect(events).toContain("RESPONSE_SENT");
  });

  it("reuses stored ISBN for a follow-up product search without re-asking", async () => {
    const isbnSpy = vi.spyOn(shopifyStorefrontAdapter, "searchByISBN");

    const session = createCallSession("CA_FOLLOW", "+1", "+2");
    await collectSpeech(session, "I need a book");
    await collectSpeech(session, "I have an ISBN");
    await collectSpeech(session, "9783161484100");
    isbnSpy.mockClear();

    const speech = await collectSpeech(session, "look up that book again");
    expect(isbnSpy).toHaveBeenCalled();
    expect(speech).toMatch(/Azkaban/i);
    expect(getOrCreateCallState(session.callSid).slots.isbn).toBe("9783161484100");
  });

  it('Phase 1: "I want to buy books" asks title, ISBN, or recommendations', async () => {
    const titleSpy = vi.spyOn(shopifyStorefrontAdapter, "searchByTitle");

    const session = createCallSession("CA_BUY", "+1", "+2");
    const speech = await collectSpeech(session, "I want to buy books");

    expect(speech).toMatch(/ISBN|title|recommend/i);
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it('Phase 1: "I want books for inmates" asks clarification, not immediate search', async () => {
    const titleSpy = vi.spyOn(shopifyStorefrontAdapter, "searchByTitle");

    const session = createCallSession("CA_REC", "+1", "+2");
    const speech = await collectSpeech(session, "I want books for inmates");

    expect(speech).toMatch(/ISBN|title/i);
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it("does not reuse similar products for unknown title searches", async () => {
    const session = createCallSession("CA_MISS", "+1", "+2");
    await collectSpeech(session, "I want a book");
    await collectSpeech(session, "I have a title");
    const speech = await collectSpeech(session, "Imaginary Title XYZ");

    expect(speech).toMatch(/could not find an exact match|closest valid alternatives/i);
  });
});
