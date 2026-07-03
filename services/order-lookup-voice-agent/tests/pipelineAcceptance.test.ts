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
import * as shopifyProductTools from "../src/tools/shopifyProductTools.js";

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
    resetShopifyScopeCheck();
    resetToolExecutionGuard();
    resetToolAccessGuard();
    resetPipelineGuard();
    vi.unstubAllGlobals();
    mockLiveShopifyFetch(mockCatalog);
  });

  it('1 — "I want a book" asks for ISBN/title, no Shopify', async () => {
    const isbnSpy = vi.spyOn(shopifyProductTools, "searchProductByISBN");
    const titleSpy = vi.spyOn(shopifyProductTools, "searchProductByTitle");

    const session = createCallSession("ACC_1", "+1", "+2");
    const speech = await collectSpeech(session, "I want a book");

    expect(speech).toMatch(/ISBN|title/i);
    expect(isbnSpy).not.toHaveBeenCalled();
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it('2 — ISBN provided triggers product search', async () => {
    const isbnSpy = vi.spyOn(shopifyProductTools, "searchProductByISBN");

    const session = createCallSession("ACC_2", "+1", "+2");
    const speech = await collectSpeech(session, "I have ISBN 9783161484100");

    expect(isbnSpy).toHaveBeenCalled();
    expect(speech).toMatch(/Azkaban|found/i);
  });

  it('3 — "Harry Potter book" asks clarification first', async () => {
    const titleSpy = vi.spyOn(shopifyProductTools, "searchProductByTitle");

    const session = createCallSession("ACC_3", "+1", "+2");
    const speech = await collectSpeech(session, "Harry Potter book");

    expect(speech).toMatch(/ISBN|title/i);
    expect(titleSpy).not.toHaveBeenCalled();
  });

  it('4 — "where is my order" uses order flow only', async () => {
    const isbnSpy = vi.spyOn(shopifyProductTools, "searchProductByISBN");
    const titleSpy = vi.spyOn(shopifyProductTools, "searchProductByTitle");

    const session = createCallSession("ACC_4", "+1", "+2");
    const speech = await collectSpeech(session, "where is my order");

    expect(speech).toMatch(/order number/i);
    expect(isbnSpy).not.toHaveBeenCalled();
    expect(titleSpy).not.toHaveBeenCalled();
  });
});
