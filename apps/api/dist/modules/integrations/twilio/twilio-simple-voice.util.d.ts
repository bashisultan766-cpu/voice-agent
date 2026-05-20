export declare function escapeXmlText(text: string): string;
export declare function escapeXmlAttr(value: string): string;
export declare function buildFastInboundTwiml(gatherActionAbsoluteUrl: string): string;
export declare function buildGatherNoSpeechTwiml(inboundAbsoluteUrl: string): string;
export declare function buildGatherAiReplyTwiml(reply: string, inboundAbsoluteUrl: string): string;
export declare function buildGatherErrorTwiml(message: string, inboundAbsoluteUrl: string): string;
