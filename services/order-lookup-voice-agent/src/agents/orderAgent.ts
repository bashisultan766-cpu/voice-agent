/**
 * @deprecated Import from conversationBrain.ts — sole voice agent entry point.
 */
export {
  BRAIN_GREETING,
  createCallSession,
  handleBrainTurn as handleAgentTurn,
  streamBrainTurn as streamAgentTurn,
} from "./conversationBrain.js";

export { ORDER_NOT_FOUND_MESSAGE, SHOPIFY_DOWN_MESSAGE } from "../utils/formatter.js";
