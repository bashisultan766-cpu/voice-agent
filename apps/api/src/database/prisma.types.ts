/**
 * Re-export Prisma client types and enums from a single module.
 * Run `pnpm --filter api exec prisma generate` after schema changes.
 */
export {
  Prisma,
  PrismaClient,
  UserRole,
  AgentStatus,
  ConnectionStatus,
  StoreStatus,
  PhoneNumberStatus,
  CallStatus,
  CallEventType,
  CallResolutionStatus,
  CallbackRequestStatus,
  OrderBookingStatus,
  CheckoutMode,
  CheckoutLinkStatus,
  EmailDeliveryStatus,
  PaymentLifecycleStatus,
  ToolExecutionStatus,
  KnowledgeDocType,
  KnowledgeStatus,
  KnowledgeSyncJobStatus,
  PromptVersionStatus,
  AgentTypeCode,
} from '@prisma/client';

export type {
  Tenant,
  User,
  Store,
  Agent,
  CallSession,
  CallTranscript,
  CallEvent,
  CallOutcome,
  CallbackRequest,
  CheckoutLink,
  PaymentRecord,
  EmailEvent,
  LeadCapture,
  TenantIntegration,
  AgentConfig,
  VoiceProfile,
  PhoneNumber,
  PhoneNumberMapping,
  ProductCache,
  VariantCache,
  ToolExecution,
  KnowledgeDocument,
  OrderBookingDraft,
  AgentQualityReview,
} from '@prisma/client';

import { CallStatus } from '@prisma/client';

/** CallSession statuses used for ended-call analytics and QA queues. */
export const TERMINAL_CALL_STATUSES: CallStatus[] = [
  CallStatus.COMPLETED,
  CallStatus.FAILED,
  CallStatus.ESCALATED,
  CallStatus.ABANDONED,
];
