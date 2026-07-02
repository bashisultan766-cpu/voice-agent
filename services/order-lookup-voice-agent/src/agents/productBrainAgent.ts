import OpenAI from "openai";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  getOrCreateCustomerMemory,
  recordAssistantPhrase,
  recordIntent,
  recordIsbnQuery,
  recordProductSearch,
  setEmotionalTone,
} from "../memory/customerMemoryStore.js";
import {
  buildPersonalityPrompt,
  detectEmotionalTone,
  shapeVoiceResponse,
} from "./personalityEngine.js";
import {
  extractIsbnFromSpeech,
  getSimilarProducts,
  searchProductByCategory,
  searchProductByISBN,
  searchProductByTitle,
  STORE_NOT_FOUND_MESSAGE,
} from "../tools/shopifyProductTools.js";
import type { StructuredProduct } from "../types/product.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: getConfig().OPENAI_API_KEY,
      timeout: getConfig().OPENAI_TIMEOUT_MS,
    });
  }
  return client;
}

export interface ProductBrainInput {
  callSid: string;
  userMessage: string;
  intent?: "product_search" | "isbn_query";
}

export interface ProductBrainResult {
  speech: string;
  products: StructuredProduct[];
  usedSimilarFallback: boolean;
}

function extractTitleQuery(speech: string): string {
  return speech
    .replace(/\b(do you have|looking for|i want|i need|any|available|books?|magazines?|newspapers?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isCategoryBrowse(speech: string): { type: string; label: string } | null {
  const lower = speech.toLowerCase();
  if (/\b(magazine|magazines)\b/.test(lower)) return { type: "Magazine", label: "magazines" };
  if (/\b(newspaper|newspapers)\b/.test(lower)) return { type: "Newspaper", label: "newspapers" };
  if (/\b(any\s+books?|books?\s+for\s+inmates|do you have (any )?books?)\b/.test(lower)) {
    return { type: "Book", label: "books" };
  }
  return null;
}

function productFacts(products: StructuredProduct[]): string {
  return products
    .slice(0, 3)
    .map((p) => {
      const price = p.variants[0]?.price ?? "N/A";
      const stock = p.variants.some((v) => v.inStock) ? "in stock" : "out of stock";
      return `"${p.title}" (${p.productType || "general"}, ${price} USD, ${stock})`;
    })
    .join("; ");
}

async function generateGroundedReply(input: {
  callSid: string;
  userMessage: string;
  products: StructuredProduct[];
  usedSimilarFallback: boolean;
  situationalHint: string;
}): Promise<string> {
  const memory = getOrCreateCustomerMemory(input.callSid);
  setEmotionalTone(memory, detectEmotionalTone(input.userMessage));

  if (input.products.length === 0) {
    const notFound = shapeVoiceResponse(STORE_NOT_FOUND_MESSAGE, memory);
    recordAssistantPhrase(memory, notFound);
    return notFound;
  }

  const system = `${buildPersonalityPrompt(memory)}

You are answering a phone call about SureShot Books products.
Use ONLY the product facts below. Never invent titles, prices, or availability.
If no product facts are listed, say you could not find it in the store right now.

Product facts: ${productFacts(input.products)}
Situation: ${input.situationalHint}`;

  try {
    const response = await getClient().chat.completions.create({
      model: getConfig().CONVERSATION_BRAIN_MODEL,
      temperature: 0.8,
      max_tokens: 120,
      messages: [
        { role: "system", content: system },
        { role: "user", content: input.userMessage },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    const shaped = shapeVoiceResponse(raw || fallbackProductReply(input), memory);
    recordAssistantPhrase(memory, shaped);
    return shaped;
  } catch (err) {
    logger.warn("product_brain_llm_failed", {
      callSid: input.callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    const fallback = shapeVoiceResponse(fallbackProductReply(input), memory);
    recordAssistantPhrase(memory, fallback);
    return fallback;
  }
}

function fallbackProductReply(input: {
  products: StructuredProduct[];
  usedSimilarFallback: boolean;
}): string {
  if (input.products.length === 0) {
    return STORE_NOT_FOUND_MESSAGE;
  }
  const top = input.products[0];
  if (input.usedSimilarFallback) {
    return `I couldn't find that exact one, but "${top.title}" is very close and ${top.variants.some((v) => v.inStock) ? "available" : "something we can look into"}.`;
  }
  return `Yes — we have "${top.title}" ${top.variants.some((v) => v.inStock) ? "in stock" : "on the catalog"} right now.`;
}

/**
 * Core product intelligence agent — title, ISBN, category browse, similar items.
 * All product data is grounded in live Shopify GraphQL fetches.
 */
export async function handleProductBrainTurn(input: ProductBrainInput): Promise<ProductBrainResult> {
  const memory = getOrCreateCustomerMemory(input.callSid);
  const speech = input.userMessage.trim();

  recordIntent(memory, input.intent ?? "product_search");
  setEmotionalTone(memory, detectEmotionalTone(speech));

  let products: StructuredProduct[] = [];
  let usedSimilarFallback = false;
  let situationalHint = "Product inquiry";

  const isbn = extractIsbnFromSpeech(speech);
  if (isbn || input.intent === "isbn_query") {
    recordIntent(memory, "isbn_query");
    const queryIsbn = isbn ?? extractTitleQuery(speech);
    if (queryIsbn) recordIsbnQuery(memory, queryIsbn);
    const result = await searchProductByISBN(queryIsbn);
    products = result.products;
    situationalHint = products.length
      ? `ISBN lookup for ${queryIsbn}`
      : `ISBN ${queryIsbn} not found in live Shopify data`;
  } else {
    const category = isCategoryBrowse(speech);
    const query = category ? category.label : extractTitleQuery(speech) || speech;

    if (category) {
      const catResult = await searchProductByCategory(`${category.label} inmates ${category.type}`);
      products = catResult.products;
      if (products.length === 0) {
        const titleResult = await searchProductByTitle(category.type);
        products = titleResult.products;
      }
    } else {
      const result = await searchProductByTitle(query);
      products = result.products;
      usedSimilarFallback = Boolean(result.usedSemanticFallback);
    }

    situationalHint = category
      ? `Browsing ${category.label} category for inmates/families`
      : products.length
        ? `Title search for "${query}"`
        : `Title "${query}" not found in live Shopify data`;
  }

  if (products.length > 0 && products.every((p) => !p.variants.some((v) => v.inStock))) {
    const similar = await getSimilarProducts(products[0].id);
    if (similar.products.length > 0) {
      products = [...products, ...similar.products].slice(0, 5);
      usedSimilarFallback = true;
      situationalHint = "Requested item out of stock — similar alternatives from live catalog";
    }
  }

  recordProductSearch(memory, products);

  const reply = await generateGroundedReply({
    callSid: input.callSid,
    userMessage: input.userMessage,
    products,
    usedSimilarFallback,
    situationalHint,
  });

  return { speech: reply, products, usedSimilarFallback };
}
