/**
 * Offline replay engine — rebuild AgentState at any timeline point without live Shopify I/O.
 */
import type { AgentEvent } from "./events.js";
import type { AgentState } from "./agentState.js";
import { createInitialAgentState } from "./agentState.js";
import { agentStateReducer } from "./reducers.js";

/**
 * Fold a chronological event list into terminal AgentState.
 * Safe for audit, multi-node simulation, and post-mortem debugging.
 */
export function replayCallTimeline(
  events: AgentEvent[],
  options: { callSid?: string; initialState?: AgentState } = {},
): AgentState {
  const callSid = options.callSid ?? options.initialState?.callSid ?? "replay";
  let state = options.initialState ?? createInitialAgentState(callSid);

  for (const event of events) {
    state = agentStateReducer(state, event);
  }

  return state;
}

/**
 * Replay until a specific turn sequence (inclusive of all events with turnSeq <= target).
 */
export function replayCallTimelineUntilTurn(
  storedEvents: Array<{ turnSeq: number; event: AgentEvent }>,
  targetTurnSeq: number,
  callSid = "replay",
): AgentState {
  const events = storedEvents
    .filter((row) => row.turnSeq <= targetTurnSeq)
    .map((row) => row.event);
  return replayCallTimeline(events, { callSid });
}
