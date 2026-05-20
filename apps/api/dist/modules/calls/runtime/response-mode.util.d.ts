import type { UserUtteranceIntent } from './user-intent-classifier.util';
import type { OrderState } from './order-state-machine.util';
import type { VoiceTurnToolTrace } from './voice-turn-tool-trace.util';
export declare function decideResponseMode(args: {
    intent: UserUtteranceIntent;
    state: OrderState;
    toolResult?: VoiceTurnToolTrace;
    customerText: string;
}): 'template' | 'openai';
