/**
 * @deprecated Removed — Shopify execution lives only in conversationOrchestrator.ts.
 */
export async function executeProductSearch(): Promise<never> {
  throw new Error("ILLEGAL_TOOL_EXECUTION_BYPASS: executeProductSearch moved to conversationOrchestrator");
}
