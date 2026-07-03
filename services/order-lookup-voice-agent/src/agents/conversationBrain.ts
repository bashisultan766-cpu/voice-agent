/**
 * Conversation Brain — compatibility facade.
 * Runtime voice turns MUST use conversationOrchestrator.process() directly.
 */
export {
  BRAIN_GREETING,
  createCallSession,
  endCallSession,
  process,
} from "./conversationOrchestrator.js";
import { process } from "./conversationOrchestrator.js";
import type { AgentStreamEvent, CallSession } from "../types/order.js";

export interface BrainTurnResult {
  speech: string;
  endCall?: boolean;
  phase: CallSession["phase"];
}

/** Streaming turn — delegates to orchestrator.process (sole pipeline). */
export async function* streamBrainTurn(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent> {
  yield* process(session.callSid, callerText, session);
}

/** Collect full turn for tests and legacy callers. */
export async function handleBrainTurn(
  session: CallSession,
  callerText: string,
): Promise<BrainTurnResult> {
  const parts: string[] = [];
  let phase = session.phase;
  let endCall = false;

  for await (const event of process(session.callSid, callerText, session)) {
    if (event.type === "chunk") parts.push(event.chunk.text);
    if (event.type === "done") {
      phase = event.phase;
      endCall = event.endCall ?? false;
    }
  }

  return { speech: parts.join(" "), phase, endCall };
}
