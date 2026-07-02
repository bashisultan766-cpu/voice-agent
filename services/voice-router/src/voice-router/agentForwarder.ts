import { getConfig, type AgentTarget } from "../config.js";
import { logger } from "../utils/logger.js";

export interface ForwardResult {
  twiml: string;
  target: AgentTarget;
  fallbackUsed: boolean;
}

export async function isOrderLookupHealthy(): Promise<boolean> {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.HEALTH_CHECK_TIMEOUT_MS);

  try {
    const res = await fetch(cfg.ORDER_LOOKUP_HEALTH_URL, {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function forwardToAgent(
  target: AgentTarget,
  twilioBody: Record<string, string>,
  meta: { callSid: string; reason: string; initialSpeech?: string },
): Promise<ForwardResult> {
  let resolvedTarget = target;
  let fallbackUsed = false;

  if (target === "order_lookup") {
    const healthy = await isOrderLookupHealthy();
    if (!healthy) {
      logger.warn("order_lookup_unhealthy_fallback", {
        callSid: meta.callSid.slice(0, 8),
        reason: meta.reason,
      });
      resolvedTarget = "main_agent";
      fallbackUsed = true;
    }
  }

  const url =
    resolvedTarget === "order_lookup"
      ? getConfig().ORDER_LOOKUP_INBOUND_URL
      : getConfig().MAIN_AGENT_INBOUND_URL;

  const twiml = await postToAgent(url, twilioBody, meta.initialSpeech);
  logger.info("agent_forward_success", {
    callSid: meta.callSid.slice(0, 8),
    target: resolvedTarget,
    reason: meta.reason,
    fallbackUsed,
  });

  return { twiml, target: resolvedTarget, fallbackUsed };
}

async function postToAgent(
  url: string,
  twilioBody: Record<string, string>,
  initialSpeech?: string,
): Promise<string> {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.AGENT_FORWARD_TIMEOUT_MS);

  try {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(twilioBody)) {
      body.set(key, String(value ?? ""));
    }
    if (initialSpeech) {
      body.set("RouterSpeech", initialSpeech);
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Voice-Router-Forward": cfg.VOICE_ROUTER_FORWARD_SECRET,
      },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`agent_forward_http_${res.status}:${text.slice(0, 120)}`);
    }

    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
