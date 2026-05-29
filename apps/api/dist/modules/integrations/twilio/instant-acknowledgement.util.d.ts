import type { UserUtteranceIntent } from '../../calls/runtime/user-intent-classifier.util';
export type InstantAckSelection = {
    mode: 'sync_full_reply';
    ackReason: string;
} | {
    mode: 'deferred_kickoff';
    instantPhrase: string | null;
    ackReason: string;
    markSessionLetMeCheck: boolean;
    nextLastProductQuery?: string | null;
};
export declare function isYesNoOnlyUtterance(text: string): boolean;
export declare function isLikelyProductCorrection(text: string): boolean;
export type SelectInstantAcknowledgementInput = {
    intent: UserUtteranceIntent;
    speechText: string;
    callState: string;
    metadata: Record<string, unknown>;
    forceElevenLabsOnly?: boolean;
};
export declare function selectInstantAcknowledgement(input: SelectInstantAcknowledgementInput): InstantAckSelection;
export declare function buildInstantAckMetadataPatch(args: {
    selection: InstantAckSelection;
    intent: UserUtteranceIntent;
    letMeCheckUsedBefore: boolean;
    instantPhraseForLog: string | null;
    syncReplyText?: string;
}): {
    lastInstantAck: string;
    lastIntentDetected: UserUtteranceIntent;
    letMeCheckUsed: boolean;
    lastProductQuery?: string | null;
};
