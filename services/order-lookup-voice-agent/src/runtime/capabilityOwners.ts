/**
 * Capability → sole workflow owner registry.
 * Invariant tests fail if any capability maps to more than one owner, if the
 * same owner string is reused for two capabilities, or if a business capability
 * is owned by a low-level HTTP client (Client / Http / QueryBoundary) instead
 * of a domain service.
 *
 * The registry is the source of truth for architecture ownership assertions —
 * update it whenever a new domain owner takes over a workflow.
 * Owner values must be globally unique strings (qualify with .method when one
 * module legitimately owns multiple capabilities).
 */
export const CAPABILITY_OWNERS = {
  // Runtime + orchestration.
  side_effects: "ActionGateway",
  call_termination: "TerminationCoordinator",
  voice_pre_turn: "VoicePreTurn",
  tracking_phase_gate: "ConversationOrchestrator.resolveTrackingPhaseGate",
  flow_mutex: "FlowMutex",
  sentiment_recovery: "maybeRecoverSentiment",

  // Domain workflows.
  checkout_plan_groups: "CheckoutDomain",
  checkout_transitions: "CheckoutTransitions",
  checkout_batch_prep: "CheckoutManager.initiateCheckoutBatch",
  checkout_invoice_delivery: "ActionGateway.executeCheckoutGroup",
  checkout_email_unknown_reconcile: "ActionGateway.reconcileEmailUnknownGroups",
  checkout_operation_persistence: "CheckoutOperationRepository",
  cart_validation_gate: "CartValidationGate",
  email_confirmation_ids: "EmailConfirmationManager",

  // Business owners for Shopify + support flows.
  // Owner strings must be unique across the registry (deployment invariant).
  product_search: "ProductSearchService",
  order_lookup: "OrderLookupService",
  order_timeline: "OrderAggregationEngine",
  sticky_order_context: "OrderContextService",
  inventory_resolution: "InventoryResolutionService",
  order_disclosure: "OrderDisclosurePolicy",
  caller_verification: "CallerVerificationService",
  support_case_creation: "SupportCaseService.createCase",
  protected_order_cache: "ProtectedOrderCache",

  // Facility / logistics policy.
  facility_policy: "FacilityPolicyEngine",
  logistics_policy_access: "LogisticsPolicyClient",

  // Infrastructure boundaries — never a business owner.
  shopify_query_access: "ShopifyQueryBoundary",
  shopify_inventory_access: "ShopifyInventoryClient",
} as const;

export type CapabilityName = keyof typeof CAPABILITY_OWNERS;

/** Forbidden duplicate owners — used by invariant tests. */
export const FORBIDDEN_SIDE_EFFECT_CALLSITES = [
  // Tools/orchestrator must not call these directly — ActionGateway only.
  "sendCheckoutEmail(",
  "createShopifyDraftOrder(",
] as const;

export const FORBIDDEN_TERMINATION_BYPASS = [
  // Direct hang-up without TerminationCoordinator.
  "sendEndCall(send)",
  "sendMediaStreamStop(send",
] as const;

/**
 * Business capabilities that MUST NOT be owned by a low-level HTTP or
 * QueryBoundary client. Enforced by the architecture invariant test.
 */
export const BUSINESS_CAPABILITIES: readonly CapabilityName[] = [
  "product_search",
  "order_lookup",
  "order_timeline",
  "sticky_order_context",
  "inventory_resolution",
  "order_disclosure",
  "caller_verification",
  "support_case_creation",
  "facility_policy",
] as const;

/** Owner-name heuristics for the infra vs domain split. */
export function isInfraOwnerName(owner: string): boolean {
  return /(?:Client$|Http|QueryBoundary$)/.test(owner);
}
