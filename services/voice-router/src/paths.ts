/** Public Twilio webhook — same URL as the original project. */
export const TWILIO_INBOUND_PATH = "/voice/twilio/inbound";

/** Internal routing callbacks (not configured in Twilio Console). */
export const ROUTING_GATHER_PATH = "/voice/twilio/routing/gather";
export const ROUTING_FORWARD_PATH = "/voice/twilio/routing/forward-to-agent";
export const ROUTING_DECIDE_PATH = "/voice/twilio/routing/decide";

export function routingGatherUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}${ROUTING_GATHER_PATH}`;
}

export function routingForwardUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}${ROUTING_FORWARD_PATH}`;
}
