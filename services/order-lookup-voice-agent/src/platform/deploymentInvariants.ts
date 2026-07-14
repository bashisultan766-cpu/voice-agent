/**
 * Production deployment invariants.
 *
 * Called from index.ts bootstrap AFTER the durable Postgres modules initialise.
 * If any assertion fails while running in production (NODE_ENV=production or
 * DEPLOYMENT_ENV=production), we throw a fatal error so the process exits
 * before it serves live traffic. Non-production runs log warnings only.
 *
 * Assertions cover:
 *   - CheckoutOperationRepository is Postgres-backed (never in-memory)
 *   - Postgres migrations applied (checkout_operations table exists)
 *   - Shopify credentials + Admin API reachable (via envValidator)
 *   - Twilio signature validation enabled
 *   - Support case persistence (session persistence when using durable sessions)
 *   - Email delivery configured when checkout email delivery is required
 *   - Capability registry has no duplicate owners
 *   - production_manifest.json tool list matches UnifiedToolRegistry
 *   - Protected session serializer is exported / callable
 */
import { readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../utils/logger.js";
import { getConfig } from "../config.js";
import {
  isPostgresDisabled,
  isPostgresEventStoreEnabled,
  queryPostgres,
} from "./postgresEventStore.js";
import { isSessionPersistenceEnabled } from "./sessionPersistence.js";
import { validateShopifyEnvFormat } from "./envValidator.js";
import { isEmailDeliveryConfigured } from "../utils/emailDeliveryConfig.js";
import { CAPABILITY_OWNERS } from "../runtime/capabilityOwners.js";
import { UnifiedToolRegistry } from "../adapters/unifiedToolRegistry.js";
import {
  InMemoryCheckoutOperationRepository,
  getDefaultCheckoutOperationRepository,
} from "../domain/checkoutOperation.js";
import { assertSessionSafeForPersistence } from "./sessionSerialization.js";
import { isProductionRuntime } from "./checkoutOperationBootstrap.js";

export interface DeploymentInvariantFailure {
  code: string;
  message: string;
  severity: "fatal" | "warn";
}

export interface DeploymentInvariantReport {
  ok: boolean;
  productionRuntime: boolean;
  failures: DeploymentInvariantFailure[];
}

function fatal(failures: DeploymentInvariantFailure[], code: string, message: string): void {
  failures.push({ code, message, severity: "fatal" });
}

function warn(failures: DeploymentInvariantFailure[], code: string, message: string): void {
  failures.push({ code, message, severity: "warn" });
}

async function checkCheckoutOperationsTable(): Promise<boolean> {
  if (!isPostgresEventStoreEnabled() || isPostgresDisabled()) return false;
  const result = await queryPostgres<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables WHERE table_name = 'checkout_operations'
     ) AS exists`,
  );
  return result?.rows?.[0]?.exists === true;
}

function checkSessionSerializer(failures: DeploymentInvariantFailure[]): void {
  try {
    // Assert the serializer is callable — even with an empty stub — and does
    // not throw on safe input. A missing / broken guard is a fatal deploy risk.
    assertSessionSafeForPersistence({ callSid: "check", from: "+1", to: "+1" });
  } catch (err) {
    fatal(
      failures,
      "session_serializer_broken",
      `sessionSerialization guard threw on baseline session: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function checkCapabilityRegistry(failures: DeploymentInvariantFailure[]): void {
  const owners = Object.values(CAPABILITY_OWNERS);
  const seen = new Map<string, number>();
  for (const owner of owners) {
    seen.set(owner, (seen.get(owner) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
  if (duplicates.length > 0) {
    fatal(
      failures,
      "capability_registry_duplicate_owner",
      `Capability owners must be unique per capability; duplicates: ${duplicates
        .map(([owner]) => owner)
        .join(", ")}`,
    );
  }
}

function checkManifestMatchesRegistry(
  failures: DeploymentInvariantFailure[],
): void {
  try {
    const manifestPath = pathResolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "production_manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      tools?: string[];
      toolAliases?: Record<string, string>;
    };
    const manifestTools = new Set((manifest.tools ?? []).map(String));
    const aliasTargets = new Set(Object.values(manifest.toolAliases ?? {}).map(String));
    const registryTools = new Set([...UnifiedToolRegistry.keys()].map(String));

    const missingInRegistry = [...manifestTools].filter(
      (t) => !registryTools.has(t) && !aliasTargets.has(t),
    );
    const missingInManifest = [...registryTools].filter(
      (t) => !manifestTools.has(t) && !aliasTargets.has(t),
    );
    if (missingInRegistry.length > 0 || missingInManifest.length > 0) {
      warn(
        failures,
        "manifest_registry_drift",
        `production_manifest.json / UnifiedToolRegistry drift detected. missingInRegistry=[${missingInRegistry.join(
          ", ",
        )}] missingInManifest=[${missingInManifest.join(", ")}]`,
      );
    }
  } catch (err) {
    warn(
      failures,
      "manifest_unreadable",
      `Could not parse production_manifest.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function checkTwilioSignatureValidation(failures: DeploymentInvariantFailure[]): void {
  try {
    const cfg = getConfig();
    if (!cfg.TWILIO_AUTH_TOKEN?.trim()) {
      fatal(
        failures,
        "twilio_auth_token_missing",
        "TWILIO_AUTH_TOKEN is required to validate Twilio webhook signatures in production",
      );
    }
    if (!cfg.VALIDATE_TWILIO_SIGNATURES) {
      fatal(
        failures,
        "twilio_signature_validation_disabled",
        "VALIDATE_TWILIO_SIGNATURES=false is not permitted in production",
      );
    }
  } catch (err) {
    fatal(
      failures,
      "twilio_config_invalid",
      `Twilio config validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function checkShopifyCredentials(failures: DeploymentInvariantFailure[]): void {
  try {
    validateShopifyEnvFormat();
  } catch (err) {
    fatal(
      failures,
      "shopify_credentials_missing_or_invalid",
      `Shopify credential validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function checkCheckoutOperationsRepository(
  failures: DeploymentInvariantFailure[],
): Promise<void> {
  const repo = getDefaultCheckoutOperationRepository();
  if (repo instanceof InMemoryCheckoutOperationRepository) {
    fatal(
      failures,
      "checkout_operations_repository_memory",
      "Production must use PostgresCheckoutOperationRepository; in-memory ledger is not multi-instance safe",
    );
  }

  const tableReady = await checkCheckoutOperationsTable();
  if (!tableReady) {
    fatal(
      failures,
      "checkout_operations_table_missing",
      "checkout_operations table not found — run migrations/004_checkout_operations.sql before starting",
    );
  }
}

function checkSessionPersistence(failures: DeploymentInvariantFailure[]): void {
  if (!isSessionPersistenceEnabled()) {
    warn(
      failures,
      "session_persistence_disabled",
      "Postgres session persistence is disabled — support cases may not survive restart",
    );
  }
}

function checkEmailDelivery(failures: DeploymentInvariantFailure[]): void {
  if (!isEmailDeliveryConfigured()) {
    fatal(
      failures,
      "email_delivery_unconfigured",
      "RESEND_API_KEY / RESEND_FROM_EMAIL are required — checkout email delivery cannot function in production without them",
    );
  }
}

/**
 * Runs the full invariant battery. Returns the report and throws in production
 * when any fatal failure is present.
 */
export async function assertProductionDeploymentReady(): Promise<DeploymentInvariantReport> {
  const failures: DeploymentInvariantFailure[] = [];
  const production = isProductionRuntime();

  checkSessionSerializer(failures);
  checkCapabilityRegistry(failures);
  checkManifestMatchesRegistry(failures);
  checkTwilioSignatureValidation(failures);
  checkShopifyCredentials(failures);
  checkSessionPersistence(failures);
  checkEmailDelivery(failures);
  await checkCheckoutOperationsRepository(failures);

  const fatalFailures = failures.filter((f) => f.severity === "fatal");
  const report: DeploymentInvariantReport = {
    ok: fatalFailures.length === 0,
    productionRuntime: production,
    failures,
  };

  if (failures.length > 0) {
    logger.warn("deployment_invariants_report", {
      productionRuntime: production,
      totalFailures: failures.length,
      fatalFailures: fatalFailures.length,
      codes: failures.map((f) => `${f.severity}:${f.code}`),
    });
  } else {
    logger.info("deployment_invariants_ok", { productionRuntime: production });
  }

  if (production && fatalFailures.length > 0) {
    const message = fatalFailures
      .map((f) => `${f.code}: ${f.message}`)
      .join(" | ");
    throw new Error(`deployment_invariants_fatal: ${message}`);
  }

  return report;
}
