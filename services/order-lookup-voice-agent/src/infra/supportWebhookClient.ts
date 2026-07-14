import { getConfig } from "../config.js";

/** Owns the support webhook transport; callers receive only notification state. */
export async function notifySupportCaseWebhook(payload: {
  caseId: string;
  callSid: string;
  reason: string;
}): Promise<boolean> {
  const webhook = getConfig().SUPPORT_HUMAN_WEBHOOK?.trim();
  if (!webhook) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "escalate_to_human", ...payload }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
