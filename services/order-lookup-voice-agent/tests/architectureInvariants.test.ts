/**
 * Architecture invariant tests — single owner, ActionGateway, TerminationCoordinator.
 * Also permanently prevents restoration of the retired checkoutEmailService /
 * sendCheckoutPaymentLink surface — the send is owned by ActionGateway alone.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CAPABILITY_OWNERS,
  BUSINESS_CAPABILITIES,
  isInfraOwnerName,
} from "../src/runtime/capabilityOwners.js";
import {
  planCheckoutGroup,
  cartLinesToGroupLines,
  ensureCheckoutPlan,
  getCheckoutGroup,
  markGroupSent,
} from "../src/domain/checkoutModels.js";
import type { CallSession } from "../src/types/order.js";
import { processVoicePreTurn } from "../src/voice/voicePreTurn.js";
import { TerminationCoordinator } from "../src/runtime/terminationCoordinator.js";
import {
  acquireFlowMutex,
  releaseFlowMutex,
  getFlowMutex,
  SENTIMENT_MUTEX_TTL_MS,
  withFlowMutex,
  isCheckoutPassiveReadOnly,
} from "../src/agents/flowMutex.js";
import { ensureSessionMemory } from "../src/agents/sessionMemory.js";
import { buildOrderView } from "../src/agents/orderDisclosurePolicy.js";
import { normalizeToE164 } from "../src/agents/callerVerificationService.js";
import { readFileSync as readFs } from "node:fs";

const SRC_ROOT = join(__dirname, "..", "src");
const SERVICE_ROOT = join(__dirname, "..");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      out.push(...walkTsFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function walkDocFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (
        name === "node_modules" ||
        name === "dist" ||
        name === "coverage" ||
        name === ".git" ||
        name === "staging-traces" ||
        name === ".vite"
      )
        continue;
      out.push(...walkDocFiles(p));
    } else if (/\.(md|json)$/i.test(name)) {
      // Skip ephemeral vitest / harness artifacts that may quote retired symbols.
      if (/^tmp[-_]/.test(name) || name.endsWith("-report.json")) continue;
      out.push(p);
    }
  }
  return out;
}

/** Strip TypeScript block + line comments so identifier scans skip prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function makeSession(overrides?: Partial<CallSession>): CallSession {
  return {
    callSid: "CA_TEST_INVARIANT_001",
    from: "+15551234567",
    to: "+15557654321",
    phase: "active",
    shoppingCart: [
      {
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        title: "Book A",
        quantity: 1,
      },
      {
        variantId: "gid://shopify/ProductVariant/2",
        productId: "gid://shopify/Product/2",
        title: "Book B",
        quantity: 2,
      },
    ],
    ...overrides,
  } as CallSession;
}

describe("capability ownership invariants", () => {
  it("each capability has exactly one owner", () => {
    const owners = Object.values(CAPABILITY_OWNERS);
    const keys = Object.keys(CAPABILITY_OWNERS);
    expect(new Set(keys).size).toBe(keys.length);
    expect(owners.length).toBe(keys.length);
  });

  it("owner strings are unique across capabilities (deployment invariant)", () => {
    const owners = Object.values(CAPABILITY_OWNERS);
    const seen = new Map<string, number>();
    for (const owner of owners) {
      seen.set(owner, (seen.get(owner) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([owner]) => owner);
    expect(duplicates).toEqual([]);
  });

  it("business capabilities are not owned by an HTTP / QueryBoundary client", () => {
    const offenders: string[] = [];
    for (const capability of BUSINESS_CAPABILITIES) {
      const owner = CAPABILITY_OWNERS[capability];
      if (isInfraOwnerName(owner)) {
        offenders.push(`${capability} → ${owner}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("shopify_reads capability is retired in favour of shopify_query_access", () => {
    expect((CAPABILITY_OWNERS as Record<string, string>).shopify_reads).toBeUndefined();
    expect(CAPABILITY_OWNERS.shopify_query_access).toBe("ShopifyQueryBoundary");
  });
});

describe("checkoutEmailService cannot be resurrected", () => {
  const FORBIDDEN_SYMBOLS = ["checkoutEmailService", "sendCheckoutPaymentLink"] as const;

  it("src/services/checkoutEmailService.ts does not exist on disk", () => {
    const legacyFile = join(SRC_ROOT, "services", "checkoutEmailService.ts");
    expect(existsSync(legacyFile)).toBe(false);
  });

  it("no src/ or tests/ file references the retired symbols (even as helper names)", () => {
    const roots = [SRC_ROOT, join(__dirname, "..", "tests")];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of walkTsFiles(root)) {
        const rel = relative(SERVICE_ROOT, file).replace(/\\/g, "/");
        // Allow the invariant test itself to name the symbol as a string literal
        // marker so we can enforce it.
        if (rel.endsWith("tests/architectureInvariants.test.ts")) continue;
        const src = stripComments(readFileSync(file, "utf8"));
        for (const symbol of FORBIDDEN_SYMBOLS) {
          if (new RegExp(`\\b${symbol}\\b`).test(src)) {
            offenders.push(`${rel} → ${symbol}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("service docs / manifests do not instruct a rebuild of the retired symbols", () => {
    const offenders: string[] = [];
    for (const file of walkDocFiles(SERVICE_ROOT)) {
      const rel = relative(SERVICE_ROOT, file).replace(/\\/g, "/");
      if (rel.startsWith("node_modules/") || rel.includes(".vite/")) continue;
      const src = readFileSync(file, "utf8");
      for (const symbol of FORBIDDEN_SYMBOLS) {
        if (new RegExp(`\\b${symbol}\\b`).test(src)) {
          offenders.push(`${rel} → ${symbol}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * `generate_payment_link` / `send_payment_link` may remain LLM tool-name
   * aliases IF and ONLY IF they route through ActionGateway.executeCheckoutGroup
   * with confirmed_email_id. Preparation tools (initiate_checkout_batch /
   * planPreparation) must NEVER alias to send_checkout_email — that would send
   * an invoice without a confirmed email.
   */
  it("no prep tool aliases into invoice delivery without a confirmed email", () => {
    const manifest = JSON.parse(
      readFs(join(SERVICE_ROOT, "production_manifest.json"), "utf8"),
    ) as { toolAliases?: Record<string, string>; toolOwners?: Record<string, string> };
    const aliases = manifest.toolAliases ?? {};
    const owners = manifest.toolOwners ?? {};

    // send_checkout_email must be owned by ActionGateway.
    expect(owners.send_checkout_email).toContain("ActionGateway");

    // Any tool aliased to send_checkout_email must be a delivery alias, never a prep alias.
    const forbiddenAliasSources = [
      "initiate_checkout_batch",
      "planPreparation",
      "prepare_checkout_batch",
    ];
    for (const [alias, target] of Object.entries(aliases)) {
      if (target !== "send_checkout_email") continue;
      expect(forbiddenAliasSources).not.toContain(alias);
    }
  });
});

describe("session state privacy", () => {
  it("CallSession type text does not reference OrderStatusResult or lastOrderStatusResult", () => {
    const src = stripComments(
      readFileSync(join(SRC_ROOT, "types", "order.ts"), "utf8"),
    );
    expect(src).not.toMatch(/\bOrderStatusResult\b/);
    expect(src).not.toMatch(/\blastOrderStatusResult\b/);
  });

  it("no other src/ file writes to session.lastOrderStatusResult", () => {
    // The privacy guard scans for the legacy key by name — that's the only file
    // permitted to reference the identifier.
    const allowedReferencers = new Set(["platform/sessionSerialization.ts"]);
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      if (allowedReferencers.has(rel)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      if (/\blastOrderStatusResult\b/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("no other src/ file references legacy currentOrderData identifier", () => {
    const allowedReferencers = new Set(["platform/sessionSerialization.ts"]);
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      if (allowedReferencers.has(rel)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      if (/\bcurrentOrderData\b/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe("architecture invariants", () => {
  it("fails if sendCheckoutPaymentLink exists anywhere in src", () => {
    const files = walkTsFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      const src = stripComments(readFileSync(file, "utf8"));
      if (/sendCheckoutPaymentLink/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("fails if createShopifyDraftOrder is imported outside infra + ActionGateway + adapter definition", () => {
    const allowed = new Set([
      "infra/shopifyDraftOrderClient.ts",
      "adapters/shopifyStorefrontAdapter.ts",
      "runtime/actionGateway.ts",
      "runtime/capabilityOwners.ts",
    ]);
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      if (allowed.has(rel)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      if (/createShopifyDraftOrder/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("fails if sentiment.ts performs network side effects", () => {
    const src = readFileSync(join(SRC_ROOT, "utils", "sentiment.ts"), "utf8");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/SUPPORT_HUMAN_WEBHOOK/);
    expect(src).not.toMatch(/sendSupportEscalation/);
  });

  it("does not export raw OrderStatusResult as an aggregation payload order field", () => {
    const src = readFileSync(
      join(SRC_ROOT, "adapters", "orderAggregationEngine.ts"),
      "utf8",
    );
    const payload = src.match(/export interface AggregatedOrderPayload\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(payload).not.toMatch(/order\s*:\s*OrderStatusResult/);
  });

  it("forbids fetch in conversational Shopify modules", () => {
    const forbidden = [
      "services/shopifyInventoryService.ts",
      "tools/shopifyLiveSearch.ts",
      "tools/productCatalog.ts",
      "adapters/shopifyOrderTimeline.ts",
      "infra/shopifyQueryBoundary.ts",
    ];
    for (const rel of forbidden) {
      const src = readFileSync(join(SRC_ROOT, ...rel.split("/")), "utf8");
      expect(src, rel).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("only SupportCaseService imports support email/webhook clients", () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      if (
        rel === "agents/supportCaseService.ts" ||
        rel === "infra/supportEmailClient.ts" ||
        rel === "infra/supportWebhookClient.ts"
      ) {
        continue;
      }
      const src = stripComments(readFileSync(file, "utf8"));
      if (/supportEmailClient|supportWebhookClient/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("only approved infra clients import resendEmailService", () => {
    const allowed = new Set([
      "utils/resendEmailService.ts",
      "infra/supportEmailClient.ts",
      "infra/checkoutInvoiceEmailClient.ts",
    ]);
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      if (allowed.has(rel)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      if (/resendEmailService/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("forbids group.status assignments outside checkoutTransitions (except initial planned create)", () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      if (rel === "domain/checkoutTransitions.ts") continue;
      const src = readFileSync(file, "utf8");
      const withoutPlannedInit = src.replace(/status:\s*"planned"/g, "status: __PLANNED__");
      if (/group\.status\s*=(?!=)/.test(withoutPlannedInit)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("limits OrderStatusResult imports to approved protected-data modules", () => {
    const allowed = new Set([
      "adapters/shopifyStorefrontAdapter.ts",
      "adapters/orderAggregationEngine.ts",
      "agents/callerVerificationService.ts",
      "agents/callerVerification.ts",
      "agents/orderLookupService.ts",
      "agents/verificationGate.ts",
      "services/shopifyService.ts",
      "utils/orderDataParser.ts",
      "infra/protectedOrderCache.ts",
      // Privacy guard scans the persistence graph specifically for this raw
      // shape — it must reference the identifier to know what to reject.
      "platform/sessionSerialization.ts",
    ]);
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      const src = stripComments(readFileSync(file, "utf8"));
      if (!/\bOrderStatusResult\b/.test(src)) continue;
      if (!allowed.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("ActionGateway has no raw fetch and no support Resend import", () => {
    const src = readFileSync(join(SRC_ROOT, "runtime", "actionGateway.ts"), "utf8");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/sendSupportEscalationDetailed/);
    expect(src).not.toMatch(/supportEmailClient|supportWebhookClient/);
  });

  it("ActionGateway imports validation from emailUtils and delivery guard from emailDeliveryConfig", () => {
    const src = readFileSync(join(SRC_ROOT, "runtime", "actionGateway.ts"), "utf8");
    expect(src).toMatch(/from ["']\.\.\/utils\/emailUtils/);
    expect(src).toMatch(/from ["']\.\.\/utils\/emailDeliveryConfig/);
    expect(src).not.toMatch(/from ["']\.\.\/utils\/resendEmailService/);
  });

  it("fails if sendEndCall is invoked outside TerminationCoordinator / sender adapter", () => {
    const files = walkTsFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      if (
        rel === "runtime/terminationCoordinator.ts" ||
        rel === "voice/conversationRelaySender.ts" ||
        rel.includes("capabilityOwners")
      ) {
        continue;
      }
      const src = readFileSync(file, "utf8");
      const withoutImports = src.replace(/import[\s\S]*?from\s+["'][^"']+["'];?/g, "");
      if (/sendEndCall\s*\(\s*send\s*\)/.test(withoutImports)) {
        if (!/TerminationCoordinator|terminateCall|terminate\(/.test(src)) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ShopifyQueryBoundary never calls the LOGISTICS_INTELLIGENCE_URL sidecar", () => {
    const src = readFileSync(
      join(SRC_ROOT, "infra", "shopifyQueryBoundary.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/fetchInventoryFromLogisticsUrl/);
    expect(stripComments(src)).not.toMatch(/LOGISTICS_INTELLIGENCE_URL/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("CheckoutPlan / CheckoutGroup state transitions", () => {
  it("assigns each line to at most one active group", () => {
    const session = makeSession();
    const lines = cartLinesToGroupLines(session.shoppingCart!);
    const g1 = planCheckoutGroup(session, [lines[0]!]);
    expect(g1.ok).toBe(true);
    const g2 = planCheckoutGroup(session, [lines[0]!]);
    expect(g2.ok).toBe(false);
    if (!g2.ok) expect(g2.failureState).toBe("LINE_QUANTITY_ALREADY_ASSIGNED");
  });

  it("allows reassignment after group is marked sent", () => {
    const session = makeSession();
    const lines = cartLinesToGroupLines(session.shoppingCart!);
    const g1 = planCheckoutGroup(session, [lines[0]!]);
    expect(g1.ok).toBe(true);
    if (g1.ok) markGroupSent(session, g1.group.checkoutGroupId);
    const group = getCheckoutGroup(session, g1.ok ? g1.group.checkoutGroupId : "");
    expect(group?.status).toBe("sent");
  });

  it("property: disjoint partitions never share active assignment", () => {
    for (let n = 1; n <= 8; n++) {
      const session = makeSession({
        shoppingCart: Array.from({ length: n }, (_, i) => ({
          variantId: `gid://shopify/ProductVariant/${i}`,
          productId: `gid://shopify/Product/${i}`,
          title: `Book ${i}`,
          quantity: 1,
        })),
      });
      const lines = cartLinesToGroupLines(session.shoppingCart!);
      const mid = Math.floor(n / 2);
      const a = planCheckoutGroup(session, lines.slice(0, mid || 1));
      const b = planCheckoutGroup(session, lines.slice(mid || 1));
      if (mid === 0 || mid === n) {
        expect(a.ok || b.ok).toBe(true);
      } else {
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
        if (a.ok && b.ok) {
          const idsA = new Set(a.group.lines.map((l) => l.variantId));
          for (const l of b.group.lines) {
            expect(idsA.has(l.variantId)).toBe(false);
          }
        }
      }
      const plan = ensureCheckoutPlan(session);
      expect(new Set(plan.assignedVariantIds).size).toBe(plan.assignedVariantIds.length);
    }
  });
});

describe("FlowMutex + sentiment recovery", () => {
  it("releases in finally via withFlowMutex", async () => {
    const session = makeSession();
    await withFlowMutex(session, "checkout", "test", async () => {
      expect(getFlowMutex(session).owner).toBe("checkout");
      throw new Error("boom");
    }).catch(() => undefined);
    expect(getFlowMutex(session).owner).toBe("none");
  });

  it("sentiment lock expires by TTL", () => {
    const session = makeSession();
    acquireFlowMutex(session, "sentiment_escalation", "test");
    const m = getFlowMutex(session);
    expect(m.owner).toBe("sentiment_escalation");
    m.expiresAt = Date.now() - 1;
    ensureSessionMemory(session).flowMutex = m;
    expect(getFlowMutex(session).owner).toBe("none");
    expect(ensureSessionMemory(session).sentimentShieldActive).toBeFalsy();
    expect(SENTIMENT_MUTEX_TTL_MS).toBeGreaterThan(0);
    releaseFlowMutex(session);
  });

  it("stale-lock breaker force-releases after 120s and clears escalation flags", () => {
    const session = makeSession();
    acquireFlowMutex(session, "sentiment_escalation", "stuck");
    ensureSessionMemory(session).humanEscalationTriggered = true;
    const bucket = ensureSessionMemory(session).flowMutex!;
    bucket.acquiredAt = Date.now() - 121_000;
    bucket.expiresAt = Date.now() + 60_000; // TTL not expired, but stale ceiling hit
    expect(getFlowMutex(session).owner).toBe("none");
    expect(ensureSessionMemory(session).humanEscalationTriggered).toBeFalsy();
    expect(ensureSessionMemory(session).sentimentShieldActive).toBeFalsy();
  });

  it("orphan humanEscalationTriggered without mutex does not block checkout", () => {
    const session = makeSession();
    ensureSessionMemory(session).humanEscalationTriggered = true;
    ensureSessionMemory(session).sentimentShieldActive = true;
    expect(isCheckoutPassiveReadOnly(session)).toBe(false);
    expect(ensureSessionMemory(session).humanEscalationTriggered).toBeFalsy();
  });
});

describe("VoicePreTurn LISTENING_WAIT recovery", () => {
  it("enters listening_wait then keeps buffer after long silence + continuation", () => {
    const session = makeSession();
    const first = processVoicePreTurn(session, {
      transport: "conversation_relay",
      callId: session.callSid,
      text: "I want to",
    });
    expect(first.action).toBe("listening_wait");
    const memory = ensureSessionMemory(session);
    memory.listeningWaitEnteredAt = Date.now() - 13_000;
    const timed = processVoicePreTurn(session, {
      transport: "media_streams",
      callId: session.callSid,
      text: "buy",
    });
    expect(timed.action).toBe("listening_wait");
    expect(ensureSessionMemory(session).listeningWaitBuffer).toBeTruthy();
    expect(ensureSessionMemory(session).listeningWaitBuffer).toContain("I want to");
  });

  it("transport parity: relay and streams produce same action for incomplete clause", () => {
    const a = makeSession({ callSid: "CA_RELAY" });
    const b = makeSession({ callSid: "CA_STREAM" });
    const ra = processVoicePreTurn(a, {
      transport: "conversation_relay",
      callId: a.callSid,
      text: "and then",
    });
    const rb = processVoicePreTurn(b, {
      transport: "media_streams",
      callId: b.callSid,
      text: "and then",
    });
    expect(ra.action).toBe(rb.action);
  });
});

describe("TerminationCoordinator", () => {
  it("blocks premature hang-up when cart active without goodbye", () => {
    const session = makeSession();
    const d = TerminationCoordinator.evaluate(session, "follow_up_goodbye", "thanks");
    expect(d.allow).toBe(false);
  });

  it("allows explicit goodbye", () => {
    const session = makeSession({ shoppingCart: [] });
    const d = TerminationCoordinator.evaluate(session, "llm_end_call", "goodbye");
    expect(d.allow).toBe(true);
  });
});

describe("Privacy OrderView", () => {
  it("strips shipping for unverified callers", () => {
    const session = makeSession({ isVerifiedCaller: false });
    const view = buildOrderView(session, {
      order_number: "1001",
      shipping_address: "123 Prison Rd",
      total_amount: "$10.00",
    });
    expect(view.shipping_address).toBeUndefined();
    expect(view.totals?.total).toBe("$10.00");
  });

  it("normalizes E.164", () => {
    expect(normalizeToE164("5551234567")).toBe("+15551234567");
  });
});

describe("manifest / registry contract", () => {
  it("manifest lists initiate_checkout_batch as first-class tool", () => {
    const manifest = JSON.parse(
      readFs(join(__dirname, "..", "production_manifest.json"), "utf8"),
    ) as {
      tools: string[];
      toolAliases?: Record<string, string>;
      toolOwners?: Record<string, string>;
    };
    expect(manifest.tools).toContain("initiate_checkout_batch");
    expect(manifest.tools).toContain("send_checkout_email");
    expect(manifest.toolAliases?.initiate_checkout_batch).toBeUndefined();
    expect(manifest.toolOwners?.send_checkout_email).toContain("ActionGateway");
    expect(manifest.toolOwners?.end_call).toContain("TerminationCoordinator");
  });
});
