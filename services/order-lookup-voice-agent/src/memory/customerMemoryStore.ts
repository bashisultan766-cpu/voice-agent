import type { StructuredProduct } from "../types/product.js";

export type CustomerEmotionalTone = "neutral" | "confused" | "frustrated" | "warm" | "urgent";
export type CustomerIntentKind =
  | "order"
  | "browsing"
  | "product_search"
  | "isbn_query"
  | "confused"
  | "greeting"
  | "support"
  | "unknown";

export interface CustomerMemory {
  callSid: string;
  lastSearchedProducts: string[];
  lastIsbnQueried?: string;
  preferredGenres: string[];
  emotionalTone: CustomerEmotionalTone;
  intentHistory: CustomerIntentKind[];
  recentAssistantPhrases: string[];
  updatedAt: number;
}

const MAX_PRODUCTS = 8;
const MAX_GENRES = 6;
const MAX_INTENTS = 12;
const MAX_PHRASES = 6;
const TTL_MS = 60 * 60 * 1000;

const memories = new Map<string, CustomerMemory>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [sid, memory] of memories.entries()) {
    if (now - memory.updatedAt > TTL_MS) {
      memories.delete(sid);
    }
  }
}

export function getOrCreateCustomerMemory(callSid: string): CustomerMemory {
  purgeExpired();
  const existing = memories.get(callSid);
  if (existing) return existing;

  const memory: CustomerMemory = {
    callSid,
    lastSearchedProducts: [],
    preferredGenres: [],
    emotionalTone: "neutral",
    intentHistory: [],
    recentAssistantPhrases: [],
    updatedAt: Date.now(),
  };
  memories.set(callSid, memory);
  return memory;
}

export function recordIntent(memory: CustomerMemory, intent: CustomerIntentKind): void {
  memory.intentHistory.unshift(intent);
  memory.intentHistory = memory.intentHistory.slice(0, MAX_INTENTS);
  memory.updatedAt = Date.now();
}

export function recordProductSearch(memory: CustomerMemory, products: StructuredProduct[]): void {
  for (const p of products) {
    if (!memory.lastSearchedProducts.includes(p.title)) {
      memory.lastSearchedProducts.unshift(p.title);
    }
    if (p.productType && !memory.preferredGenres.includes(p.productType)) {
      memory.preferredGenres.unshift(p.productType);
    }
    for (const tag of p.tags.slice(0, 2)) {
      if (!memory.preferredGenres.includes(tag)) {
        memory.preferredGenres.unshift(tag);
      }
    }
  }
  memory.lastSearchedProducts = memory.lastSearchedProducts.slice(0, MAX_PRODUCTS);
  memory.preferredGenres = memory.preferredGenres.slice(0, MAX_GENRES);
  memory.updatedAt = Date.now();
}

export function recordIsbnQuery(memory: CustomerMemory, isbn: string): void {
  memory.lastIsbnQueried = isbn;
  memory.updatedAt = Date.now();
}

export function recordAssistantPhrase(memory: CustomerMemory, phrase: string): void {
  memory.recentAssistantPhrases.unshift(phrase.trim());
  memory.recentAssistantPhrases = memory.recentAssistantPhrases.slice(0, MAX_PHRASES);
  memory.updatedAt = Date.now();
}

export function setEmotionalTone(memory: CustomerMemory, tone: CustomerEmotionalTone): void {
  memory.emotionalTone = tone;
  memory.updatedAt = Date.now();
}

export function clearCustomerMemory(callSid: string): void {
  memories.delete(callSid);
}

export function clearAllCustomerMemories(): void {
  memories.clear();
}
