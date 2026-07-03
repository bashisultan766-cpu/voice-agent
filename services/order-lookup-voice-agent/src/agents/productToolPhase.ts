/**
 * @deprecated Removed — Shopify execution lives only in conversationOrchestrator.ts.
 */
export async function executeProductSearch(): Promise<never> {
  throw new Error("DIRECT_TOOL_EXECUTION_FORBIDDEN: executeProductSearch moved to conversationOrchestrator");
}
