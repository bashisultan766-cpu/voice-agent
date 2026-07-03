/**
 * Multi-intent dialogue manager — agenda queue for patient, sequential fulfillment.
 */
import type { FulfillmentIntent } from "../nlp/entityExtractor.js";
import { detectMultiIntentAgenda, type DialogueAgendaItem } from "../nlp/entityExtractor.js";

export type { DialogueAgendaItem };

export interface DialogueState {
  agenda: DialogueAgendaItem[];
  currentIndex: number;
  planAnnounced: boolean;
  /** Items fully resolved in prior turns (prevents re-asking for order after completion). */
  resolved: DialogueAgendaItem[];
}

const dialogueByCall = new Map<string, DialogueState>();

export function getDialogueState(callSid: string): DialogueState {
  const existing = dialogueByCall.get(callSid);
  if (existing) return existing;
  const fresh: DialogueState = {
    agenda: [],
    currentIndex: 0,
    planAnnounced: false,
    resolved: [],
  };
  dialogueByCall.set(callSid, fresh);
  return fresh;
}

export function clearDialogueState(callSid: string): void {
  dialogueByCall.delete(callSid);
}

export function clearAllDialogueStates(): void {
  dialogueByCall.clear();
}

/** Merge newly detected intents into the agenda without duplicating. */
export function updateAgendaFromSpeech(callSid: string, speech: string): DialogueState {
  const state = getDialogueState(callSid);
  const detected = detectMultiIntentAgenda(speech);

  for (const item of detected) {
    if (!state.agenda.includes(item)) {
      state.agenda.push(item);
    }
  }

  advanceToNextUnresolved(state);
  return state;
}

function advanceToNextUnresolved(state: DialogueState): void {
  while (
    state.currentIndex < state.agenda.length &&
    state.resolved.includes(state.agenda[state.currentIndex]!)
  ) {
    state.currentIndex += 1;
  }
}

export function markAgendaItemResolved(
  callSid: string,
  item: DialogueAgendaItem,
): DialogueAgendaItem | null {
  const state = getDialogueState(callSid);
  if (!state.resolved.includes(item)) {
    state.resolved.push(item);
  }
  advanceToNextUnresolved(state);
  return state.agenda[state.currentIndex] ?? null;
}

export function getCurrentAgendaItem(callSid: string): DialogueAgendaItem | null {
  const state = getDialogueState(callSid);
  return state.agenda[state.currentIndex] ?? null;
}

export function hasPendingAgendaItems(callSid: string): boolean {
  const state = getDialogueState(callSid);
  return state.currentIndex < state.agenda.length - 1;
}

/** Mark current agenda item complete and advance. Returns the next item if any. */
export function completeCurrentAgendaItem(callSid: string): DialogueAgendaItem | null {
  const state = getDialogueState(callSid);
  const current = state.agenda[state.currentIndex];
  if (!current) return null;
  return markAgendaItemResolved(callSid, current);
}

export function markPlanAnnounced(callSid: string): void {
  getDialogueState(callSid).planAnnounced = true;
}

export function shouldAnnouncePlan(callSid: string, speech: string): boolean {
  const state = getDialogueState(callSid);
  if (state.planAnnounced) return false;
  return detectMultiIntentAgenda(speech).length >= 2 || state.agenda.length >= 2;
}

/** Opening plan when caller requests multiple tasks in one breath. */
export function buildAgendaPlanTts(agenda: DialogueAgendaItem[]): string {
  if (agenda.length < 2) return "";

  const hasOrder = agenda.includes("order_status");
  const hasBook = agenda.includes("product_search");

  if (hasOrder && hasBook) {
    return "I'd be happy to help you with both. Let's start with your order status. What is your order number?";
  }

  return "I can help with everything you mentioned. Let's take it one step at a time.";
}

/** Bridge utterance when moving to the next agenda item. */
export function buildAgendaTransitionTts(nextItem: DialogueAgendaItem): string {
  if (nextItem === "product_search") {
    return "Alright, that takes care of your order. Now, you mentioned you wanted to look for a book. Do you have an ISBN or a title in mind?";
  }
  if (nextItem === "order_status") {
    return "Now let's look at your order. What is your order number?";
  }
  return "What would you like to do next?";
}

/** Map agenda item to fulfillment intent for the active turn. */
export function agendaItemToIntent(item: DialogueAgendaItem): FulfillmentIntent {
  return item === "order_status" ? "order_status" : "title_search";
}

export function activeAgendaAwaitingSlot(
  item: DialogueAgendaItem | null,
): "order_number" | "title" | "isbn" | null {
  if (item === "order_status") return "order_number";
  if (item === "product_search") return null;
  return null;
}
