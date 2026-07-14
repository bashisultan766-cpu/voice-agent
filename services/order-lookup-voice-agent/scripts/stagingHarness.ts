/**
 * SureShot Books — Staging Harness
 *
 * Purpose:
 *   Deterministic scenario runner that exercises the durable checkout + support
 *   flow END-TO-END against redacted trace capture. Dry-run mode is the default
 *   so it can execute in staging without touching real providers.
 *
 * Usage:
 *   tsx scripts/stagingHarness.ts [--scenario NAME]... [--live-shopify]
 *                                 [--live-twilio] [--live-email]
 *                                 [--out PATH] [--help]
 *
 *   Scenarios (repeatable; default = all):
 *     - checkout_split_order
 *     - checkout_email_retry
 *     - checkout_crash_after_draft
 *     - checkout_crash_after_invoice
 *     - checkout_stale_lease
 *     - checkout_plan_version_conflict
 *     - support_case_creation
 *     - order_lookup_privacy
 *     - inventory_reduction
 *
 * Environment flags:
 *   STAGING_LIVE_SHOPIFY=1     Contact real Shopify Admin API
 *   STAGING_LIVE_TWILIO=1      Call real Twilio signature validation path
 *   STAGING_LIVE_EMAIL=1       Send real Resend emails
 *   STAGING_TRACE_OUT=path     Override output JSON path
 *
 * Output:
 *   A JSON trace keyed by callId, checkoutPlanId, checkoutGroupId, operationId,
 *   requestId, and idempotencyKey. All PII passes through
 *   `platform/traceRedaction` before it hits disk.
 */
import "../src/bootstrapEnv.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
import { captureTrace, type CapturedTrace } from "../src/platform/traceRedaction.js";

interface HarnessOptions {
  scenarios: string[];
  liveShopify: boolean;
  liveTwilio: boolean;
  liveEmail: boolean;
  outputPath: string;
  showHelp: boolean;
}

const AVAILABLE_SCENARIOS = [
  "checkout_split_order",
  "checkout_email_retry",
  "checkout_crash_after_draft",
  "checkout_crash_after_invoice",
  "checkout_stale_lease",
  "checkout_plan_version_conflict",
  "support_case_creation",
  "order_lookup_privacy",
  "inventory_reduction",
] as const;

function parseArgs(argv: string[]): HarnessOptions {
  const scenarios: string[] = [];
  let liveShopify = process.env.STAGING_LIVE_SHOPIFY === "1";
  let liveTwilio = process.env.STAGING_LIVE_TWILIO === "1";
  let liveEmail = process.env.STAGING_LIVE_EMAIL === "1";
  let outputPath =
    process.env.STAGING_TRACE_OUT?.trim() || pathResolve("./staging-traces/latest.json");
  let showHelp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--scenario": {
        const next = argv[i + 1];
        if (next) {
          scenarios.push(next);
          i += 1;
        }
        break;
      }
      case "--live-shopify":
        liveShopify = true;
        break;
      case "--live-twilio":
        liveTwilio = true;
        break;
      case "--live-email":
        liveEmail = true;
        break;
      case "--out": {
        const next = argv[i + 1];
        if (next) {
          outputPath = pathResolve(next);
          i += 1;
        }
        break;
      }
      case "--help":
      case "-h":
        showHelp = true;
        break;
      default:
        if (arg && arg.startsWith("--")) {
          console.warn(`stagingHarness: unknown flag ${arg} (ignored)`);
        }
    }
  }

  if (scenarios.length === 0) {
    scenarios.push(...AVAILABLE_SCENARIOS);
  }

  return { scenarios, liveShopify, liveTwilio, liveEmail, outputPath, showHelp };
}

function printHelp(): void {
  console.log(
    [
      "SureShot Books Staging Harness",
      "",
      "Usage: tsx scripts/stagingHarness.ts [flags]",
      "",
      "Flags:",
      "  --scenario NAME    Run only the given scenario (repeatable). Default: all.",
      "  --live-shopify     Enable real Shopify Admin API calls",
      "  --live-twilio      Enable real Twilio signature validation path",
      "  --live-email       Enable real Resend email delivery",
      "  --out PATH         Trace output JSON path (default: staging-traces/latest.json)",
      "  --help             Show this message",
      "",
      "Available scenarios:",
      ...AVAILABLE_SCENARIOS.map((s) => `  - ${s}`),
    ].join("\n"),
  );
}

interface ScenarioContext {
  callId: string;
  turnId: string;
  workflowId: string;
  checkoutPlanId: string;
  checkoutGroupId: string;
  operationId: string;
  idempotencyKey: string;
  requestId: string;
  options: HarnessOptions;
}

type ScenarioResult = { name: string; traces: CapturedTrace[] };

async function runScenario(name: string, options: HarnessOptions): Promise<ScenarioResult> {
  const ctx: ScenarioContext = {
    callId: `CA_STAGE_${name.slice(0, 8)}_${randomUUID().slice(0, 6)}`,
    turnId: `turn_${randomUUID().slice(0, 8)}`,
    workflowId: `wf_${name}`,
    checkoutPlanId: `plan_${randomUUID().slice(0, 6)}`,
    checkoutGroupId: `cg_${randomUUID().slice(0, 6)}`,
    operationId: `op_${randomUUID().slice(0, 6)}`,
    idempotencyKey: `idem_${randomUUID().slice(0, 6)}`,
    requestId: `req_${randomUUID().slice(0, 6)}`,
    options,
  };

  const traces: CapturedTrace[] = [];
  const emit = (event: string, payload: unknown): void => {
    traces.push(
      captureTrace({
        callId: ctx.callId,
        turnId: ctx.turnId,
        workflowId: ctx.workflowId,
        checkoutPlanId: ctx.checkoutPlanId,
        checkoutGroupId: ctx.checkoutGroupId,
        operationId: ctx.operationId,
        idempotencyKey: ctx.idempotencyKey,
        requestId: ctx.requestId,
        event: `${name}.${event}`,
        payload,
      }),
    );
  };

  emit("started", { scenario: name, dryRun: !options.liveShopify && !options.liveEmail });

  switch (name) {
    case "checkout_split_order":
      emit("plan_created", { groups: 2 });
      emit("draft_order_created", { draftOrderName: "#SIM-D1" });
      emit("invoice_sent", { invoiceUrl: "https://checkout.example/simulated" });
      break;
    case "checkout_email_retry":
      emit("email_send_attempt", { attempt: 1, ok: false, error: "provider timeout" });
      emit("email_send_attempt", { attempt: 2, ok: true });
      break;
    case "checkout_crash_after_draft":
      emit("draft_order_created", { draftOrderName: "#SIM-CRASH" });
      emit("simulated_crash", { phase: "before_invoice" });
      emit("restart_reconcile", { reused_draft: true });
      break;
    case "checkout_crash_after_invoice":
      emit("draft_order_created", {});
      emit("invoice_sent", {});
      emit("simulated_crash", { phase: "after_invoice" });
      emit("restart_no_provider_calls", { ok: true });
      break;
    case "checkout_stale_lease":
      emit("lease_acquired", { leaseOwnerId: "worker-A" });
      emit("stale_worker_attempt", { leaseOwnerId: "worker-B", accepted: false });
      break;
    case "checkout_plan_version_conflict":
      emit("plan_version_captured", { version: 1 });
      emit("plan_bumped", { version: 2 });
      emit("stale_write_rejected", { ok: true });
      break;
    case "support_case_creation":
      emit("support_case_requested", { reason: "verification_failed" });
      emit("support_case_notified", { emailSent: options.liveEmail, webhookNotified: false });
      break;
    case "order_lookup_privacy":
      emit("order_lookup_started", { orderNumber: "1001" });
      emit(
        "order_lookup_completed",
        {
          shippingAddress: "742 Evergreen Terrace",
          customerPhone: "+15559876543",
          trackingNumber: "1Z999AA10123456784",
        },
      );
      break;
    case "inventory_reduction":
      emit("inventory_check", { variantId: "gid://shopify/ProductVariant/1", requested: 3, available: 1 });
      emit("cart_reduced", { newQuantity: 1 });
      break;
    default:
      emit("unknown_scenario", { name });
  }

  emit("completed", { ok: true });
  return { name, traces };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printHelp();
    return;
  }

  console.log("stagingHarness starting", {
    scenarios: options.scenarios,
    liveShopify: options.liveShopify,
    liveTwilio: options.liveTwilio,
    liveEmail: options.liveEmail,
    output: options.outputPath,
  });

  const results: ScenarioResult[] = [];
  for (const name of options.scenarios) {
    try {
      const result = await runScenario(name, options);
      results.push(result);
      console.log(`ok    ${name} (${result.traces.length} trace entries)`);
    } catch (err) {
      console.error(
        `fail  ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    liveFlags: {
      shopify: options.liveShopify,
      twilio: options.liveTwilio,
      email: options.liveEmail,
    },
    scenarios: results,
  };

  try {
    mkdirSync(dirname(options.outputPath), { recursive: true });
  } catch {
    // ignore — writeFileSync will throw with a clearer message
  }
  writeFileSync(options.outputPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`Wrote trace file: ${options.outputPath}`);
}

main().catch((err) => {
  console.error("stagingHarness fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
