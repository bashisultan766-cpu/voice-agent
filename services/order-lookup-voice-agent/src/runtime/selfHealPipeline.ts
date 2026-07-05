/**

 * Self-healing pipeline — re-sync memory and restart clean on failure patterns.

 *

 * Infinite-loop guard: API throttle / circuit-open failures MUST NOT trigger

 * immediate repeat searches or validation-failure heal loops.

 */

import type { CallMemory, SessionProductMemory } from "../memory/callMemoryStore.js";

import {

  applyProductMemoryToCallState,

  getOrCreateCallState,

  saveCallState,

  syncSlotsToProductMemory,

  type CallState,

} from "../memory/callStateStore.js";

import { isShopifyCircuitOpen, isShopifyDegraded } from "../platform/circuitBreaker.js";

import { clearShopifyAdapterState } from "../tools/shopifyProductAdapter.js";

import { isCompleteIsbnValue, normalizeIsbn } from "../utils/productSearchNormalize.js";

import { logger } from "../utils/logger.js";

import {

  getTurnHealth,

  logTurnHealthState,

  recordFrustrationSignal,

  recordMemoryDesync,

  recordUserUtterance,

} from "./turnHealthMonitor.js";



const FRUSTRATION_RE =

  /\b(frustrated|frustrating|angry|upset|annoyed|ridiculous|terrible|already told you|i said|why do you keep|stop asking)\b/i;



export type SelfHealReason =

  | "repeated_tool_failure"

  | "repeated_validation_failure"

  | "memory_desync"

  | "user_frustration"

  | "repeated_utterance";



export interface SelfHealEvaluation {

  shouldHeal: boolean;

  reasons: SelfHealReason[];

  treatAsRepeatSearch: boolean;

  /** Block instant ISBN/title re-query (throttle death-loop prevention). */

  blockRepeatSearch: boolean;

  /** Catalog API degraded — yield graceful TTS, wait for circuit backoff. */

  degradedMode: boolean;

}



export function detectFrustrationSignal(text: string): boolean {

  return FRUSTRATION_RE.test(text);

}



/** Detect slot/memory divergence — memory is authoritative. */

export function detectMemoryDesync(

  callState: CallState,

  productMemory: SessionProductMemory,

): boolean {

  const slotIsbn = callState.slots.isbn;

  const memIsbn = productMemory.isbn;



  if (slotIsbn && memIsbn && isCompleteIsbnValue(slotIsbn) && isCompleteIsbnValue(memIsbn)) {

    if (normalizeIsbn(slotIsbn) !== normalizeIsbn(memIsbn)) return true;

  }



  const slotTitle = callState.slots.title?.trim().toLowerCase();

  const memTitle = productMemory.title?.trim().toLowerCase();

  if (slotTitle && memTitle && slotTitle !== memTitle && productMemory.titleCollected) {

    return true;

  }



  return false;

}



export function evaluateSelfHeal(

  callSid: string,

  userText: string,

  productMemory: SessionProductMemory,

  callState?: CallState,

): SelfHealEvaluation {

  const state = callState ?? getOrCreateCallState(callSid);

  const reasons: SelfHealReason[] = [];



  recordUserUtterance(callSid, userText);

  const health = getTurnHealth(callSid);



  const apiDegraded =

    isShopifyDegraded() || health.consecutiveApiThrottleFailures >= 1;



  if (apiDegraded) {

    return {

      shouldHeal: false,

      reasons: [],

      treatAsRepeatSearch: false,

      blockRepeatSearch: true,

      degradedMode: true,

    };

  }



  if (detectFrustrationSignal(userText)) {

    recordFrustrationSignal(callSid);

    reasons.push("user_frustration");

  }



  if (health.consecutiveToolFailures >= 2) {

    reasons.push("repeated_tool_failure");

  }



  if (health.consecutiveValidationFailures >= 2 && health.consecutiveApiThrottleFailures === 0) {

    reasons.push("repeated_validation_failure");

  }



  if (detectMemoryDesync(state, productMemory)) {

    recordMemoryDesync(callSid);

    reasons.push("memory_desync");

  }



  if (health.repeatedUtteranceCount >= 1) {

    reasons.push("repeated_utterance");

  }



  const blockRepeatSearch =

    isShopifyCircuitOpen() ||

    health.consecutiveApiThrottleFailures > 0 ||

    reasons.includes("repeated_validation_failure");



  const treatAsRepeatSearch =

    !blockRepeatSearch &&

    (reasons.includes("repeated_utterance") || reasons.includes("user_frustration"));



  return {

    shouldHeal: reasons.length > 0,

    reasons,

    treatAsRepeatSearch,

    blockRepeatSearch,

    degradedMode: false,

  };

}



/** Re-sync session memory from call state and clear stale retrieval cache. */

export function performSelfHeal(callSid: string, memory: CallMemory): SessionProductMemory {

  const callState = getOrCreateCallState(callSid);



  logger.info("self_heal_triggered", {

    callSid: callSid.slice(0, 8),

    health: getTurnHealth(callSid),

  });



  const sync = syncSlotsToProductMemory(memory, callState.slots, callState.slotFlags);

  const healedState = applyProductMemoryToCallState(callState, sync.memory);

  saveCallState(healedState);



  clearShopifyAdapterState(callSid);



  logger.info("self_heal_memory_resync", {

    callSid: callSid.slice(0, 8),

    isbn: sync.memory.isbn,

    title: sync.memory.title,

    lastSearchKey: sync.memory.lastSearchKey,

    memoryWins: sync.log.memoryWins,

  });



  logTurnHealthState(callSid, "post_self_heal");

  return sync.memory;

}



export function shouldForceRepeatSearch(evaluation: SelfHealEvaluation): boolean {

  return evaluation.treatAsRepeatSearch && !evaluation.blockRepeatSearch;

}


