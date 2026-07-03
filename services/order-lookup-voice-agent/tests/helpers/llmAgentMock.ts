/**
 * Deterministic LLM agent mock for vitest — simulates tool-calling without OpenAI.
 */
import type { LlmAgentTurnInput, LlmAgentTurnResult } from "../../src/adapters/openaiAdapter.js";
import {
  buildBookFoundTts,
  buildOrderStatusTts,
} from "../../src/agents/fulfillmentHandlers.js";
import {
  extractIsbnFromStt,
  extractOrderNumberFromStt,
  extractTitleFromStt,
} from "../../src/nlp/entityExtractor.js";
import { extractIsbnFromSpeech } from "../../src/utils/productSearchNormalize.js";
import type { LlmToolExecutionRecord } from "../../src/adapters/llmToolExecutor.js";

function lastAssistantAsked(messages: LlmAgentTurnInput["messages"], pattern: RegExp): boolean {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return Boolean(last && pattern.test(last.content));
}

function findIsbnInHistory(messages: LlmAgentTurnInput["messages"]): string | null {
  for (const m of [...messages].reverse()) {
    if (m.role !== "user") continue;
    const isbn = extractIsbnFromStt(m.content) ?? extractIsbnFromSpeech(m.content);
    if (isbn) return isbn;
  }
  return null;
}

function isBookIntent(text: string): boolean {
  return /\b(book|books|magazine|isbn|title|buy|purchase|harry potter)\b/i.test(text);
}

async function runTool(
  tool: LlmToolExecutionRecord["tool"],
  args: Record<string, string>,
  callSid: string,
): Promise<LlmToolExecutionRecord> {
  const { executeLlmTool } = await import("../../src/adapters/llmToolExecutor.js");
  return executeLlmTool(tool, args, callSid);
}

export async function defaultTestLlmAgentTurn(
  input: LlmAgentTurnInput,
): Promise<LlmAgentTurnResult> {
  const text = input.userMessage.trim();
  const lower = text.toLowerCase();
  const toolExecutions: LlmAgentTurnResult["toolExecutions"] = [];

  if (/^(hi|hello|hey)\b/i.test(lower)) {
    return {
      speech: "Hi, I'm the SureShot Books Assistant. How can I help you today?",
      toolExecutions: [],
      responseType: "general_help",
    };
  }

  if (
    /\b(first|start)\b.*\b(book|buy)\b.*\b(then|and)\b.*\b(order|track)/i.test(text) ||
    /\b(buy|book)\b.*\b(then|and)\b.*\b(order|track)/i.test(text)
  ) {
    return {
      speech:
        "Absolutely — let's start with finding a book. Do you have an ISBN or a title in mind?",
      toolExecutions: [],
      responseType: "clarification_question",
    };
  }

  const orderNumber =
    extractOrderNumberFromStt(text, {
      awaitingSlot: lastAssistantAsked(input.messages, /order number/i),
    }) ?? extractOrderNumberFromStt(text);

  if (orderNumber && (/\b(order|track|status|number)\b/i.test(lower) || /^\d{4,}$/.test(text))) {
    const exec = await runTool(
      "get_shopify_order_status",
      { orderNumber },
      input.callSid,
    );
    toolExecutions.push(exec);
    const speech =
      exec.ok && exec.data && "orderNumber" in exec.data
        ? buildOrderStatusTts(exec.data).text
        : "I couldn't find an order with that number. Could you double-check it for me?";
    return {
      speech,
      toolExecutions,
      responseType: exec.ok ? "order_found" : "order_not_found",
      recordOrderNumber: orderNumber,
    };
  }

  if (/\b(where is my order|order status|track my order|my order)\b/i.test(lower) && !orderNumber) {
    return {
      speech: "Sure — what's your order number?",
      toolExecutions: [],
      responseType: "clarification_question",
    };
  }

  const priorBookAsk = input.messages.some((m) =>
    /\b(need|want|buy|looking for)\b.*\b(book|books)\b/i.test(m.content),
  );

  if (!priorBookAsk && /\bi have (an )?isbn\b/i.test(lower)) {
    return {
      speech: "Great — could you share the ISBN number with me?",
      toolExecutions: [],
      responseType: "clarification_question",
    };
  }

  const isbn = extractIsbnFromStt(text) ?? extractIsbnFromSpeech(text);
  const declaredIsbn =
    /\b(i have an isbn|isbn number|read the isbn)\b/i.test(lower) ||
    lastAssistantAsked(input.messages, /share the isbn|read the isbn|what.*isbn|isbn number/i);
  const declaredTitle =
    /\b(i have a title|the title is)\b/i.test(lower) ||
    lastAssistantAsked(input.messages, /what title|share the title|tell me the title/i);

  if (/\bi have (an )?isbn\b/i.test(lower) && !(extractIsbnFromStt(text) ?? extractIsbnFromSpeech(text))) {
    return {
      speech: "Great — could you share the ISBN number with me?",
      toolExecutions: [],
      responseType: "clarification_question",
    };
  }

  if (isbn && priorBookAsk && (declaredIsbn || lastAssistantAsked(input.messages, /isbn number|share the isbn|read the isbn/i))) {
    const exec = await runTool(
      "search_shopify_book_by_isbn",
      { isbn },
      input.callSid,
    );
    toolExecutions.push(exec);
    const speech =
      exec.ok && exec.data && "bookName" in exec.data
        ? buildBookFoundTts(exec.data).text
        : "I couldn't find a book with that ISBN. Would you like to try the title instead?";
    return {
      speech,
      toolExecutions,
      responseType: exec.ok ? "confirmed_product" : "not_found",
      recordProduct:
        exec.ok && exec.data && "bookName" in exec.data
          ? { id: exec.data.productId ?? "unknown", title: exec.data.bookName ?? "Book" }
          : undefined,
    };
  }

  if (declaredTitle && text.length >= 3 && !/^(i have a title|title)$/i.test(text)) {
    const title = extractTitleFromStt(text) ?? text;
    const exec = await runTool(
      "search_shopify_book_by_title",
      { title },
      input.callSid,
    );
    toolExecutions.push(exec);
    if (exec.ok && exec.data && "bookName" in exec.data) {
      return {
        speech: buildBookFoundTts(exec.data).text,
        toolExecutions,
        responseType: "confirmed_product",
        recordProduct: {
          id: exec.data.productId ?? "unknown",
          title: exec.data.bookName ?? title,
        },
      };
    }
    return {
      speech:
        "I could not find an exact match for that title. Do you have the closest valid alternatives or another title to try?",
      toolExecutions,
      responseType: "not_found",
    };
  }

  if (/\b(i have an isbn|isbn number)\b/i.test(lower) && !isbn) {
    return {
      speech: "Great — could you share the ISBN number with me?",
      toolExecutions: [],
      responseType: "clarification_question",
    };
  }

  if (/\b(i have a title)\b/i.test(lower)) {
    return {
      speech: "Perfect — what title are you looking for?",
      toolExecutions: [],
      responseType: "clarification_question",
    };
  }

  if (/\b(need|want|buy|looking for)\b.*\b(book|books)\b/i.test(lower) && !isbn) {
    return {
      speech:
        "I'd love to help you find a book. Do you have a title, an ISBN, or would you like recommendations?",
      toolExecutions: [],
      responseType: "clarification_question",
    };
  }

  if (/\bharry potter\b/i.test(lower) && !declaredTitle) {
    return {
      speech: "I can help with Harry Potter — do you have an ISBN or a specific title in mind?",
      toolExecutions: [],
      responseType: "clarification_question",
    };
  }

  if (/\b(again|repeat|look up that book)\b/i.test(lower)) {
    const prevIsbn = findIsbnInHistory(input.messages);
    if (prevIsbn) {
      const exec = await runTool(
        "search_shopify_book_by_isbn",
        { isbn: prevIsbn },
        input.callSid,
      );
      toolExecutions.push(exec);
      const speech =
        exec.ok && exec.data && "bookName" in exec.data
          ? buildBookFoundTts(exec.data).text
          : "I couldn't find that book just now. Want to try another ISBN or title?";
      return {
        speech,
        toolExecutions,
        responseType: exec.ok ? "confirmed_product" : "not_found",
      };
    }
  }

  if (/\b(books for inmates|inmate)\b/i.test(lower)) {
    return {
      speech: "I can help with books for inmates — do you have a title or ISBN, or need suggestions?",
      toolExecutions: [],
      responseType: "clarification_question",
    };
  }

  return {
    speech: "I'm here to help with book orders and lookups. What would you like to do?",
    toolExecutions: [],
    responseType: "general_help",
  };
}
