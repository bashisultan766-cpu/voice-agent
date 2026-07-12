/**
 * Edge-case resilience — timeouts, barge-in tool discard, silence/unintelligible STT.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeUnifiedTool } from "../src/adapters/unifiedToolRegistry.js";
import { toolResultForLlm } from "../src/adapters/llmToolExecutor.js";
import { speechForOrderLookupResult } from "../src/agents/orderLookupWorkflow.js";
import {
  ARE_YOU_STILL_THERE_SPEECH,
  SHOPIFY_TIMEOUT_LLM_PAYLOAD,
  SHOPIFY_TIMEOUT_SPOKEN,
} from "../src/constants/systemMessages.js";
import {
  abortActiveTurn,
  beginTurnAbort,
  clearAllTurnAbortsForTests,
  getTurnGeneration,
  isStaleTurnGeneration,
} from "../src/runtime/turnAbortRegistry.js";
import { TimeoutError, withTimeout } from "../src/utils/promiseTimeout.js";
import {
  isShortConfirmationTranscript,
  isUnintelligibleTranscript,
  shouldPromptAreYouStillThere,
} from "../src/utils/noiseGate.js";
import type { OrderStatusResult } from "../src/adapters/shopifyStorefrontAdapter.js";
import * as shopifyService from "../src/services/shopifyService.js";

describe("edgeCases — promise timeout", () => {
  it("rejects when the operation exceeds the deadline", async () => {
    await expect(
      withTimeout(
        new Promise((resolve) => setTimeout(() => resolve("late"), 50)),
        10,
        "slow_op",
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("resolves when the operation finishes in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100, "fast_op")).resolves.toBe("ok");
  });
});

describe("edgeCases — Shopify / tool timeout fallback", () => {
  beforeEach(() => {
    clearAllTurnAbortsForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAllTurnAbortsForTests();
  });

  it("maps Shopify API timeout to the slow-system spoken line", () => {
    expect(
      speechForOrderLookupResult({
        status: "api_error",
        message: "Shopify API timeout",
      }),
    ).toBe(SHOPIFY_TIMEOUT_SPOKEN);
  });

  it("formats timeout tool results for the LLM with the required error key", () => {
    const payload = JSON.parse(
      toolResultForLlm({
        tool: "get_shopify_order_status",
        args: { orderNumber: "21698" },
        ok: false,
        status: "api_error",
        errorMessage: "Shopify API timeout",
        data: { status: "api_error", message: "Shopify API timeout" },
        elapsedMs: 6001,
      }),
    );
    expect(payload.error).toBe("Shopify API timeout");
    expect(payload.instructions).toMatch(/running a bit slow/i);
    expect(payload).toMatchObject(SHOPIFY_TIMEOUT_LLM_PAYLOAD);
  });

  it("executeUnifiedTool returns structured timeout when Shopify hangs", async () => {
    vi.spyOn(shopifyService, "lookupOrderStatus").mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        }) as Promise<OrderStatusResult>,
    );

    // Force a tiny tool timeout for this case without mutating global config permanently.
    const configMod = await import("../src/config.js");
    const original = configMod.getConfig();
    vi.spyOn(configMod, "getConfig").mockReturnValue({
      ...original,
      TOOL_EXECUTION_TIMEOUT_MS: 40,
      SHOPIFY_TIMEOUT_MS: 40,
    });

    beginTurnAbort("CA_EDGE_TIMEOUT");
    const record = await executeUnifiedTool(
      "get_shopify_order_status",
      { orderNumber: "21698" },
      "CA_EDGE_TIMEOUT",
    );

    expect(record.ok).toBe(false);
    expect(record.status).toBe("api_error");
    expect(record.errorMessage).toMatch(/timeout/i);
    expect(JSON.parse(toolResultForLlm(record)).error).toBe("Shopify API timeout");
  });
});

describe("edgeCases — barge-in discards late tool results", () => {
  beforeEach(() => {
    clearAllTurnAbortsForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAllTurnAbortsForTests();
  });

  it("bumps turn generation on barge-in so in-flight work is stale", () => {
    beginTurnAbort("CA_EDGE_BARGE");
    const gen = getTurnGeneration("CA_EDGE_BARGE");
    abortActiveTurn("CA_EDGE_BARGE");
    expect(isStaleTurnGeneration("CA_EDGE_BARGE", gen)).toBe(true);
  });

  it("discards Shopify results that finish after barge-in", async () => {
    let release!: (value: OrderStatusResult) => void;
    const pending = new Promise<OrderStatusResult>((resolve) => {
      release = resolve;
    });
    vi.spyOn(shopifyService, "lookupOrderStatus").mockReturnValue(pending);

    const configMod = await import("../src/config.js");
    const original = configMod.getConfig();
    vi.spyOn(configMod, "getConfig").mockReturnValue({
      ...original,
      TOOL_EXECUTION_TIMEOUT_MS: 5000,
      SHOPIFY_TIMEOUT_MS: 5000,
    });

    beginTurnAbort("CA_EDGE_RACE");
    const gen = getTurnGeneration("CA_EDGE_RACE");
    const toolPromise = executeUnifiedTool(
      "get_shopify_order_status",
      { orderNumber: "48065" },
      "CA_EDGE_RACE",
    );

    // Caller barges in while Shopify is still in flight.
    abortActiveTurn("CA_EDGE_RACE");
    expect(isStaleTurnGeneration("CA_EDGE_RACE", gen)).toBe(true);

    release({
      status: "found",
      orderNumber: "48065",
      customerName: "Late Result",
      itemCount: 1,
    } as OrderStatusResult);

    const record = await toolPromise;
    expect(record.ok).toBe(false);
    expect(record.errorMessage).toMatch(/discarded/i);
  });
});

describe("edgeCases — silence and unintelligible audio", () => {
  it("prompts are-you-still-there for empty and cough-like STT", () => {
    expect(shouldPromptAreYouStillThere("")).toBe(true);
    expect(shouldPromptAreYouStillThere("   ")).toBe(true);
    expect(shouldPromptAreYouStillThere("cough")).toBe(true);
    expect(shouldPromptAreYouStillThere("[inaudible]")).toBe(true);
    expect(shouldPromptAreYouStillThere("um")).toBe(true);
    expect(ARE_YOU_STILL_THERE_SPEECH).toMatch(/still there/i);
  });

  it("allows short yes/no confirmations through to the agent", () => {
    expect(isShortConfirmationTranscript("yes")).toBe(true);
    expect(isShortConfirmationTranscript("no")).toBe(true);
    expect(shouldPromptAreYouStillThere("yes")).toBe(false);
    expect(shouldPromptAreYouStillThere("where is my order")).toBe(false);
  });

  it("flags unintelligible markers without treating real speech as noise", () => {
    expect(isUnintelligibleTranscript("cough")).toBe(true);
    expect(isUnintelligibleTranscript("Harry Potter")).toBe(false);
  });
});
