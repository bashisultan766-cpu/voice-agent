import { beforeEach, describe, expect, it, vi } from "vitest";
import { runOrchestratorTurn } from "../src/agents/conversationOrchestrator.js";
import { createCallSession } from "../src/agents/orderAgent.js";
import { clearAllCallMemories } from "../src/memory/callMemoryStore.js";
import { clearAllCallStates } from "../src/memory/callStateStore.js";
import { resetPipelineGuard } from "../src/guards/pipelineGuard.js";
import { resetToolAccessGuard } from "../src/guards/toolAccessGuard.js";
import { resetToolExecutionGuard } from "../src/guards/toolExecutionGuard.js";
import { resetShopifyScopeCheck } from "../src/tools/shopifyScopeCheck.js";
import { mockLiveShopifyFetch } from "./helpers/mockLiveShopify.js";
import type { StructuredProduct } from "../src/types/product.js";
import * as shopifyProductAdapter from "../src/tools/shopifyProductAdapter.js";
import { clearAllTurnQueues } from "../src/runtime/turnExecutionQueue.js";
import { clearAllStreamBarriers } from "../src/runtime/streamTurnBarrier.js";
import { clearAllTurnHealth } from "../src/runtime/turnHealthMonitor.js";
import { clearAllCallEventSessions } from "../src/platform/eventDispatcher.js";

const mockCatalog: StructuredProduct[] = [
  {
    id: "1",
    title: "Harry Potter and the Prisoner of Azkaban",
    handle: "hp-azkaban",
    productType: "Book",
    vendor: "J.K. Rowling",
    tags: ["fiction"],
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

describe("pipeline acceptance", () => {
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
    vi.unstubAllGlobals();
    mockLiveShopifyFetch(mockCatalog);
  });

  it('1 — "I want a book" asks for ISBN/title, no Shopify', async () => {
    const isbnSpy = vi.spyOn(shopifyProductAdapter, "searchProductByISBNIsolated");
    const titleSpy = vi.spyOn(shopifyProductAdapter, "searchProductByTitleIsolated");

    const session = createCallSession("ACC_1", "+1", "+2");
    const speech = await collectSpeech(session, "I want a book");

    expect(speech).toMatch(/ISBN|title/i);
    expect(isbnSpy).not.toHaveBeenCalled();
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it('2 — cold-start ISBN utterance does NOT search (must collect slot first)', async () => {
    const isbnSpy = vi.spyOn(shopifyProductAdapter, "searchProductByISBNIsolated");

    const session = createCallSession("ACC_2", "+1", "+2");
    const speech = await collectSpeech(session, "I have ISBN 9783161484100");

    expect(isbnSpy).not.toHaveBeenCalled();
    expect(speech).toMatch(/ISBN|title/i);
  });

  it('2b — "I have ISBN" stores intent only, no search', async () => {
    const isbnSpy = vi.spyOn(shopifyProductAdapter, "searchProductByISBNIsolated");

    const session = createCallSession("ACC_2B", "+1", "+2");
    await collectSpeech(session, "I want a book");
    const speech = await collectSpeech(session, "I have an ISBN");

    expect(isbnSpy).not.toHaveBeenCalled();
    expect(speech).toMatch(/give me.*ISBN|share.*ISBN/i);
  });

  it('3 — "Harry Potter book" asks clarification first', async () => {
    const titleSpy = vi.spyOn(shopifyProductAdapter, "searchProductByTitleIsolated");

    const session = createCallSession("ACC_3", "+1", "+2");
    const speech = await collectSpeech(session, "Harry Potter book");

    expect(speech).toMatch(/ISBN|title/i);
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it('4 — "where is my order" uses order flow only', async () => {
    const isbnSpy = vi.spyOn(shopifyProductAdapter, "searchProductByISBNIsolated");
    const titleSpy = vi.spyOn(shopifyProductAdapter, "searchProductByTitleIsolated");

    const session = createCallSession("ACC_4", "+1", "+2");
    const speech = await collectSpeech(session, "where is my order");

    expect(speech).toMatch(/order number/i);
    expect(isbnSpy).not.toHaveBeenCalled();
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it('5 — three-step title flow: intent → declare title → provide title → search', async () => {
    const titleSpy = vi.spyOn(shopifyProductAdapter, "searchProductByTitleIsolated");

    const session = createCallSession("ACC_5", "+1", "+2");
    const ask1 = await collectSpeech(session, "I want to buy a book");
    expect(ask1).toMatch(/title|ISBN|topic/i);
    expect(titleSpy).not.toHaveBeenCalled();

    const ask2 = await collectSpeech(session, "I have a title");
    expect(ask2).toMatch(/give me.*title|what.*title|share.*title|tell me the title/i);
    expect(titleSpy).not.toHaveBeenCalled();

    const result = await collectSpeech(session, "Harry Potter");
    expect(titleSpy).toHaveBeenCalled();
    expect(result).toMatch(/Harry Potter|Azkaban/i);
  });

  it('6b — spoken-digit ISBN triggers Shopify search after three-step flow', async () => {
    const isbnSpy = vi.spyOn(shopifyProductAdapter, "searchProductByISBNIsolated");

    const session = createCallSession("ACC_6B", "+1", "+2");
    await collectSpeech(session, "I need a book");
    await collectSpeech(session, "I have an ISBN");
    const spoken =
      "nine seven eight three one six one four eight four one zero zero";
    const result = await collectSpeech(session, spoken);

    expect(isbnSpy).toHaveBeenCalled();
    expect(result).toMatch(/Azkaban/i);
  });

  it('6 — three-step ISBN flow: intent → declare ISBN → provide ISBN → search', async () => {
    const isbnSpy = vi.spyOn(shopifyProductAdapter, "searchProductByISBNIsolated");

    const session = createCallSession("ACC_6", "+1", "+2");
    await collectSpeech(session, "I need a book");
    const ask2 = await collectSpeech(session, "I have an ISBN number");
    expect(ask2).toMatch(/ISBN/i);
    expect(isbnSpy).not.toHaveBeenCalled();

    const result = await collectSpeech(session, "9783161484100");
    expect(isbnSpy).toHaveBeenCalled();
    expect(result).toMatch(/Azkaban/i);
  });

  it("7 — Shopify tools throw when slot validation is not ready", async () => {
    const { searchProductByISBN } = await import("../src/tools/shopifyProductTools.js");
    const {
      setToolExecutionPhase,
      setSlotValidationReady,
      resetToolExecutionGuard,
    } = await import("../src/guards/toolExecutionGuard.js");
    const { runWithToolAuthorizationAsync, resetToolAccessGuard } = await import(
      "../src/guards/toolAccessGuard.js"
    );

    resetToolExecutionGuard();
    resetToolAccessGuard();
    setToolExecutionPhase("ACC_GUARD", "PHASE_2");
    setSlotValidationReady("ACC_GUARD", false);

    await expect(
      runWithToolAuthorizationAsync("conversationOrchestrator", () =>
        searchProductByISBN("9783161484100"),
      ),
    ).rejects.toThrow("BLOCKED: INVALID SLOT STATE - ISBN OR TITLE REQUIRED");
  });
});
