import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyOrchestratorIntent,
  runOrchestratorTurn,
} from "../src/agents/conversationOrchestrator.js";
import { createCallSession } from "../src/agents/orderAgent.js";
import { clearAllCallMemories } from "../src/memory/callMemoryStore.js";
import { clearAllCallStates, getOrCreateCallState } from "../src/memory/callStateStore.js";
import { mockLiveShopifyFetch } from "./helpers/mockLiveShopify.js";
import type { StructuredProduct } from "../src/types/product.js";
import { resetShopifyScopeCheck } from "../src/tools/shopifyScopeCheck.js";
import { resetToolExecutionGuard } from "../src/guards/toolExecutionGuard.js";
import { resetToolAccessGuard } from "../src/guards/toolAccessGuard.js";
import { enablePipelineGuardForTests, resetPipelineGuard } from "../src/guards/pipelineGuard.js";
import * as shopifyProductTools from "../src/tools/shopifyProductTools.js";

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
    resetShopifyScopeCheck();
    resetToolExecutionGuard();
    resetToolAccessGuard();
    resetPipelineGuard();
    enablePipelineGuardForTests(true);
    vi.unstubAllGlobals();
    mockLiveShopifyFetch(mockCatalog);
  });

  it('greets naturally on "hello" without order-number demand', async () => {
    const session = createCallSession("CA_ORCH", "+1", "+2");
    const speech = await collectSpeech(session, "hello");
    expect(speech).toMatch(/Sureshot Books|help|today/i);
    expect(speech).not.toMatch(/valid order number|didn't catch/i);
  });

  it("asks for order number on order status", async () => {
    const session = createCallSession("CA_ORD", "+1", "+2");
    const speech = await collectSpeech(session, "where is my order");
    expect(speech).toMatch(/order number/i);
    expect(session.awaitingInput).toBe("order_number");
  });

  it('Phase 1: "I need a book" asks for ISBN or title without Shopify', async () => {
    const isbnSpy = vi.spyOn(shopifyProductTools, "searchProductByISBN");
    const titleSpy = vi.spyOn(shopifyProductTools, "searchProductByTitle");

    const session = createCallSession("CA_NEED", "+1", "+2");
    const speech = await collectSpeech(session, "I need a book");

    expect(speech).toMatch(/title or an ISBN|ISBN|recommendations/i);
    expect(session.awaitingInput).toBe("product_slot");
    expect(isbnSpy).not.toHaveBeenCalled();
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it('Phase 1: "Harry Potter book" asks clarification before Shopify', async () => {
    const titleSpy = vi.spyOn(shopifyProductTools, "searchProductByTitle");

    const session = createCallSession("CA_HP", "+1", "+2");
    const speech = await collectSpeech(session, "I want Harry Potter book");

    expect(speech).toMatch(/ISBN|title|recommend/i);
    expect(session.awaitingInput).toBe("product_slot");
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it("Phase 2: searches Harry Potter after slot confirmation", async () => {
    const session = createCallSession("CA_HP2", "+1", "+2");
    await collectSpeech(session, "I want a book");
    const speech = await collectSpeech(session, "Harry Potter");
    expect(speech).toMatch(/Harry Potter|Azkaban|found/i);
    expect(speech).not.toMatch(/let me search|I will check/i);
  });

  it("Phase 2: looks up ISBN directly", async () => {
    const session = createCallSession("CA_ISBN", "+1", "+2");
    const speech = await collectSpeech(session, "I have ISBN 9783161484100");
    expect(speech).toMatch(/Azkaban|found/i);
    expect(speech).not.toMatch(/let me search|I will check/i);
  });

  it("persists call state: book ask then ISBN search", async () => {
    const session = createCallSession("CA_STATE", "+1", "+2");
    const askSpeech = await collectSpeech(session, "I need a book");
    expect(askSpeech).toMatch(/ISBN|title/i);

    const stateAfterAsk = getOrCreateCallState(session.callSid);
    expect(stateAfterAsk.intent).toBe("product");
    expect(stateAfterAsk.awaitingInput).toBe("isbn_or_title");
    expect(stateAfterAsk.phase).toBe("PHASE_1");

    const searchSpeech = await collectSpeech(session, "I have ISBN 9783161484100");
    expect(searchSpeech).toMatch(/Azkaban|found/i);

    const stateAfterSearch = getOrCreateCallState(session.callSid);
    expect(stateAfterSearch.slots).toEqual({});
    expect(stateAfterSearch.awaitingInput).toBe("none");
    expect(stateAfterSearch.phase).toBe("PHASE_1");
  });

  it('Phase 1: "I want to buy books" asks title, ISBN, or recommendations', async () => {
    const titleSpy = vi.spyOn(shopifyProductTools, "searchProductByTitle");

    const session = createCallSession("CA_BUY", "+1", "+2");
    const speech = await collectSpeech(session, "I want to buy books");

    expect(speech).toMatch(/ISBN|title|recommend/i);
    expect(session.awaitingInput).toBe("product_slot");
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it('Phase 1: "I want books for inmates" asks clarification, not immediate search', async () => {
    const titleSpy = vi.spyOn(shopifyProductTools, "searchProductByTitle");

    const session = createCallSession("CA_REC", "+1", "+2");
    const speech = await collectSpeech(session, "I want books for inmates");

    expect(speech).toMatch(/ISBN|title/i);
    expect(session.awaitingInput).toBe("product_slot");
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it("shows similar products when exact title not found", async () => {
    const similarSpy = vi.spyOn(shopifyProductTools, "getSimilarProducts");

    const session = createCallSession("CA_MISS", "+1", "+2");
    await collectSpeech(session, "I want a book");
    const speech = await collectSpeech(session, "Imaginary Title XYZ");

    expect(speech).toMatch(/don't have that exact book|similar options/i);
    expect(similarSpy).toHaveBeenCalled();
  });
});
