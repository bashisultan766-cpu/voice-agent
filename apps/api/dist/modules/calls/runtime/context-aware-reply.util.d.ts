import type { OrderState } from './order-state-machine.util';
import type { UserUtteranceIntent } from './user-intent-classifier.util';
import type { VoiceTurnToolTrace } from './voice-turn-tool-trace.util';
import { type ConversationTone } from './conversation-tone.util';
import type { CallConversationMemory } from '@bookstore-voice-agents/types';
type ConversationTurn = {
    role: 'user' | 'assistant';
    content: string;
};
export declare function buildContextAwareReply(args: {
    intent: UserUtteranceIntent;
    state: OrderState;
    previousState: OrderState;
    lastUserMessage: string;
    toolResult?: VoiceTurnToolTrace;
    conversationHistory: ConversationTurn[];
    conversationTone: ConversationTone;
    lastToneLeadUsed: string | null;
    allowPaymentSuggestion: boolean;
    followUpOfferedProductKey?: string | null;
    conversationMemory?: CallConversationMemory;
}): {
    text: string;
    source: 'template' | 'openai';
    templateKey?: string;
    questionAnsweredFirst: boolean;
    interruptionHandled: boolean;
    toneLeadUsed: string | null;
    paymentSuggestionUsed: boolean;
    followUpTriggered?: boolean;
    followUpOfferedProductKey?: string | null;
} | null;
export {};
