/**
 * State projection — materializes AgentState into legacy read-only store views.
 *
 * Phase 2: callMemoryStore / callStateStore update ONLY through this module
 * immediately after dispatchAgentEvent applies the reducer.
 */
import type { CallMemory } from "../memory/callMemoryStore.js";
import { getOrCreateMemory } from "../memory/callMemoryStore.js";
import type { CallState } from "../memory/callStateStore.js";
import { createInitialCallState, getOrCreateCallState } from "../memory/callStateStore.js";
import type { AgentState } from "./agentState.js";
import { agentStateToCallSnapshot, createInitialAgentState } from "./agentState.js";

const agentStates = new Map<string, AgentState>();

let projectionWritesEnabled = true;

/** Test hook — disable when unit-testing store helpers in isolation. */
export function setProjectionWritesEnabled(enabled: boolean): void {
  projectionWritesEnabled = enabled;
}

export function getAgentState(callSid: string): AgentState {
  const existing = agentStates.get(callSid);
  if (existing) return existing;

  const memory = getOrCreateMemory(callSid);
  const callState = getOrCreateCallState(callSid);
  const hydrated = hydrateAgentStateFromStores(callSid, memory, callState);
  agentStates.set(callSid, hydrated);
  return hydrated;
}

export function setAgentState(callSid: string, state: AgentState): void {
  agentStates.set(callSid, state);
  if (projectionWritesEnabled) {
    projectAgentStateToStores(state);
  }
}

export function clearAgentState(callSid: string): void {
  agentStates.delete(callSid);
}

export function clearAllAgentStates(): void {
  agentStates.clear();
}

function hydrateAgentStateFromStores(
  callSid: string,
  memory: CallMemory,
  callState: CallState,
): AgentState {
  return {
    callSid,
    turnSeq: 0,
    messages: structuredClone(memory.messages),
    recentAssistantPhrases: [...memory.recentAssistantPhrases],
    inferredIntent: memory.inferredIntent,
    lastIntent: memory.lastIntent,
    lastOrderNumber: memory.lastOrderNumber,
    lastProductId: memory.lastProductId ?? memory.product.lastResultProductId,
    lastProductTitle: memory.lastProductTitle,
    product: structuredClone(memory.product),
    phase: callState.phase,
    intent: callState.intent,
    slots: structuredClone(callState.slots),
    slotFlags: structuredClone(callState.slotFlags),
    awaitingInput: callState.awaitingInput,
    runtime: {},
    updatedAt: Math.max(memory.updatedAt, callState.updatedAt),
  };
}

/** Push authoritative AgentState into legacy Map-backed stores (read-only views). */
export function projectAgentStateToStores(state: AgentState): void {
  const memory = getOrCreateMemory(state.callSid);
  memory.messages = structuredClone(state.messages);
  memory.recentAssistantPhrases = [...state.recentAssistantPhrases];
  memory.inferredIntent = state.inferredIntent;
  memory.lastIntent = state.lastIntent;
  memory.lastOrderNumber = state.lastOrderNumber;
  memory.lastProductId = state.lastProductId;
  memory.lastProductTitle = state.lastProductTitle;
  memory.product = structuredClone(state.product);
  memory.updatedAt = state.updatedAt;

  const callState = getOrCreateCallState(state.callSid);
  callState.phase = state.phase;
  callState.intent = state.intent;
  callState.slots = structuredClone(state.slots);
  callState.slotFlags = structuredClone(state.slotFlags);
  callState.awaitingInput = state.awaitingInput;
  callState.updatedAt = state.updatedAt;
}

export function ensureAgentState(callSid: string): AgentState {
  let state = agentStates.get(callSid);
  if (!state) {
    state = createInitialAgentState(callSid);
    agentStates.set(callSid, state);
    projectAgentStateToStores(state);
  }
  return state;
}

export function resetAgentStateForCall(callSid: string): void {
  const initial = createInitialAgentState(callSid);
  agentStates.set(callSid, initial);
  projectAgentStateToStores(initial);

  const callState = createInitialCallState(callSid);
  const memory = getOrCreateMemory(callSid);
  memory.messages = [];
  memory.recentAssistantPhrases = [];
  memory.product = initial.product;
  memory.updatedAt = initial.updatedAt;
  Object.assign(getOrCreateCallState(callSid), callState);
}

export function captureProjectionSnapshot(callSid: string) {
  return agentStateToCallSnapshot(getAgentState(callSid));
}
