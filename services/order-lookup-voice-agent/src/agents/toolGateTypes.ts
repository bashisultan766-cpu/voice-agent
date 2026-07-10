/**
 * Shared intent/tool action labels used by observability and call-state.
 * Production tool I/O goes through UnifiedToolRegistry — not a deterministic gate.
 */
export type GateIntent = "order" | "product" | "general" | "unknown";

export type ToolAction =
  | "ASK_QUESTION"
  | "searchProductByISBN"
  | "searchProductByTitle"
  | "getSimilarProducts"
  | "orderLookupTool"
  | "conversationOnly";
