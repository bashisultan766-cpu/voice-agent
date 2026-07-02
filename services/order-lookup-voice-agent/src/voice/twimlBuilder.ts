import { getConfig, VOICE_PATH_PREFIX } from "../config.js";

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function turnActionUrl(): string {
  const base = getConfig().PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}${VOICE_PATH_PREFIX}/turn`;
}

function inboundActionUrl(): string {
  const base = getConfig().PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}${VOICE_PATH_PREFIX}/inbound`;
}

export function buildPlayGatherTwiml(audioUrls: string[]): string {
  const plays = audioUrls.map((url) => `<Play>${escapeXml(url)}</Play>`).join("");
  return `${XML_HEADER}<Response>${plays}<Gather input="speech" action="${escapeXml(turnActionUrl())}" method="POST" speechTimeout="auto" timeout="8" language="en-US" /></Response>`;
}

export function buildGreetingTwiml(greetingAudioUrl: string): string {
  return `${XML_HEADER}<Response><Gather input="speech" action="${escapeXml(turnActionUrl())}" method="POST" speechTimeout="auto" timeout="8" language="en-US"><Play>${escapeXml(greetingAudioUrl)}</Play></Gather><Redirect>${escapeXml(inboundActionUrl())}</Redirect></Response>`;
}

export function buildHangupTwiml(audioUrls: string[] = []): string {
  const plays = audioUrls.map((url) => `<Play>${escapeXml(url)}</Play>`).join("");
  return `${XML_HEADER}<Response>${plays}<Hangup/></Response>`;
}

export function buildNoInputTwiml(repromptAudioUrl: string): string {
  return `${XML_HEADER}<Response><Gather input="speech" action="${escapeXml(turnActionUrl())}" method="POST" speechTimeout="auto" timeout="8" language="en-US"><Play>${escapeXml(repromptAudioUrl)}</Play></Gather><Hangup/></Response>`;
}
