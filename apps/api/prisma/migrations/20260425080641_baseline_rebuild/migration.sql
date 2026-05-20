-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'SUPPORT');

-- CreateEnum
CREATE TYPE "StoreStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'DISABLED', 'PROVISIONING', 'READY', 'ERROR');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('UNKNOWN', 'OK', 'FAILED');

-- CreateEnum
CREATE TYPE "PhoneNumberStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'UNASSIGNED');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('INITIATED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'ESCALATED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "KnowledgeDocType" AS ENUM ('FAQ', 'POLICY', 'SHIPPING_POLICY', 'RETURN_POLICY', 'STORE_INFO', 'BRANCH_INFO', 'DELIVERY_INFO', 'RETURNS_INFO', 'PROMOTION', 'HOLIDAY_HOURS', 'SOP', 'CUSTOM');

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PromptVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ToolExecutionStatus" AS ENUM ('SUCCESS', 'FAILED', 'TIMEOUT', 'BLOCKED');

-- CreateEnum
CREATE TYPE "AgentTypeCode" AS ENUM ('SHOPIFY_VOICE_SALES');

-- CreateEnum
CREATE TYPE "CheckoutMode" AS ENUM ('STOREFRONT_CART', 'DRAFT_ORDER_INVOICE');

-- CreateEnum
CREATE TYPE "CheckoutLinkStatus" AS ENUM ('CREATED', 'SENT', 'OPENED', 'COMPLETED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'FAILED');

-- CreateEnum
CREATE TYPE "KnowledgeSyncJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CallEventType" AS ENUM ('INBOUND_CALL_RECEIVED', 'AGENT_RESOLVED', 'CALL_SESSION_CREATED', 'TWILIO_CONNECTED', 'OPENAI_SESSION_STARTED', 'TRANSCRIPT_CHUNK_ADDED', 'TOOL_CALLED', 'TOOL_SUCCEEDED', 'TOOL_FAILED', 'ESCALATION_TRIGGERED', 'FALLBACK_USED', 'CALL_COMPLETED', 'CALL_FAILED');

-- CreateEnum
CREATE TYPE "CallResolutionStatus" AS ENUM ('RESOLVED', 'PARTIALLY_RESOLVED', 'UNRESOLVED', 'ESCALATED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "CallbackRequestStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderBookingStatus" AS ENUM ('DRAFT', 'READY_FOR_PAYMENT', 'CHECKOUT_CREATED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentType" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" "AgentTypeCode" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT,
    "passwordHash" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'MANAGER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "city" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "timezone" TEXT,
    "status" "StoreStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "branchCode" TEXT,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "area" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "email" TEXT,
    "openingHoursJson" JSONB,
    "pickupAvailable" BOOLEAN NOT NULL DEFAULT false,
    "deliveryAvailable" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreFAQ" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "branchProfileId" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "tags" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreFAQ_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "apiVersion" TEXT,
    "scopes" TEXT,
    "connectedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT,
    "agentTypeId" TEXT,
    "storeId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT,
    "voice" TEXT,
    "voiceProvider" TEXT,
    "voiceId" TEXT,
    "voiceStyle" TEXT,
    "baseSystemPrompt" TEXT NOT NULL DEFAULT '',
    "greetingMessage" TEXT,
    "fallbackMessage" TEXT,
    "escalationMessage" TEXT,
    "model" TEXT,
    "temperature" DOUBLE PRECISION,
    "status" "AgentStatus" NOT NULL DEFAULT 'DRAFT',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "enabledTools" JSONB,
    "maxToolCallsPerTurn" INTEGER DEFAULT 2,
    "handoffEnabled" BOOLEAN NOT NULL DEFAULT true,
    "voiceResponseStyle" TEXT,
    "storeName" TEXT,
    "storeUrl" TEXT,
    "storeEmail" TEXT,
    "agentGoal" TEXT,
    "agentRole" TEXT,
    "toneOfVoice" TEXT,
    "allowedActions" TEXT,
    "restrictedActions" TEXT,
    "escalationInstructions" TEXT,
    "returnRefundBehavior" TEXT,
    "orderStatusHandling" TEXT,
    "outOfStockHandling" TEXT,
    "transferToHumanEnabled" BOOLEAN NOT NULL DEFAULT true,
    "escalationPhone" TEXT,
    "escalationEmail" TEXT,
    "shopifyStoreUrl" TEXT,
    "knowledgeBaseSource" TEXT,
    "knowledgeSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "twilioPhoneNumber" TEXT,
    "callRoutingMode" TEXT,
    "incomingCallHandling" TEXT,
    "databaseProvider" TEXT,
    "shopifyConnectionStatus" "ConnectionStatus" NOT NULL DEFAULT 'UNKNOWN',
    "databaseConnectionStatus" "ConnectionStatus" NOT NULL DEFAULT 'UNKNOWN',
    "twilioConnectionStatus" "ConnectionStatus" NOT NULL DEFAULT 'UNKNOWN',
    "openaiConnectionStatus" "ConnectionStatus" NOT NULL DEFAULT 'UNKNOWN',
    "elevenlabsConnectionStatus" "ConnectionStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastConnectionTestAt" TIMESTAMP(3),
    "secretsEnc" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "supportEmail" TEXT,
    "supportPhone" TEXT,
    "businessName" TEXT,
    "askEmailBeforePaymentLink" BOOLEAN NOT NULL DEFAULT true,
    "checkoutMode" "CheckoutMode" NOT NULL DEFAULT 'STOREFRONT_CART',
    "humanHandoffRules" TEXT,
    "shippingPolicy" TEXT,
    "returnPolicy" TEXT,
    "exchangePolicy" TEXT,
    "deliveryNotes" TEXT,
    "forbiddenBehaviors" TEXT,
    "escalationRules" TEXT,
    "fallbackHumanContact" TEXT,
    "customSystemPrompt" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "voice" TEXT,
    "tone" TEXT,
    "greetingMessage" TEXT,
    "providerConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneNumberMapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'twilio',
    "providerSid" TEXT,
    "isPrimaryInbound" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneNumberMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneNumber" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT,
    "twilioSid" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "friendlyName" TEXT,
    "status" "PhoneNumberStatus" NOT NULL DEFAULT 'UNASSIGNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "branchProfileId" TEXT,
    "title" TEXT NOT NULL,
    "type" "KnowledgeDocType" NOT NULL DEFAULT 'CUSTOM',
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'DRAFT',
    "language" TEXT NOT NULL DEFAULT 'en',
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "sourceFileId" TEXT,
    "vectorStoreId" TEXT,
    "vectorFileId" TEXT,
    "metadata" JSONB,
    "isVoiceOptimized" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeSourceFile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "storageUrl" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeSourceFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeSyncJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "documentId" TEXT,
    "sourceFileId" TEXT,
    "vectorStoreId" TEXT,
    "vectorFileId" TEXT,
    "status" "KnowledgeSyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "status" "PromptVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT,
    "agentId" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "twilioCallSid" TEXT,
    "twilioStreamSid" TEXT,
    "fromNumber" TEXT,
    "toNumber" TEXT,
    "status" "CallStatus" NOT NULL DEFAULT 'INITIATED',
    "direction" TEXT,
    "startedAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "transcriptText" TEXT,
    "summary" TEXT,
    "sentiment" TEXT,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "recordingUrl" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "metadata" JSONB,
    "openaiSessionId" TEXT,
    "endedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "callSessionId" TEXT NOT NULL,
    "type" "CallEventType" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallOutcome" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "callSessionId" TEXT NOT NULL,
    "resolutionStatus" "CallResolutionStatus" NOT NULL,
    "primaryIntent" TEXT,
    "secondaryIntent" TEXT,
    "customerVerified" BOOLEAN NOT NULL DEFAULT false,
    "toolsUsedCount" INTEGER NOT NULL DEFAULT 0,
    "toolFailuresCount" INTEGER NOT NULL DEFAULT 0,
    "fallbackCount" INTEGER NOT NULL DEFAULT 0,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "callbackRequested" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT,
    "qaScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallbackRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "callSessionId" TEXT,
    "phone" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "priority" TEXT,
    "status" "CallbackRequestStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallbackRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderBookingDraft" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "callSessionId" TEXT NOT NULL,
    "status" "OrderBookingStatus" NOT NULL DEFAULT 'DRAFT',
    "itemsJson" JSONB,
    "customerJson" JSONB,
    "deliveryAddressJson" JSONB,
    "checkoutUrl" TEXT,
    "paymentChannel" TEXT,
    "paymentDestination" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderBookingDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentQualityReview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "callSessionId" TEXT NOT NULL,
    "reviewerUserId" TEXT,
    "accuracyScore" DOUBLE PRECISION,
    "toneScore" DOUBLE PRECISION,
    "policyComplianceScore" DOUBLE PRECISION,
    "brevityScore" DOUBLE PRECISION,
    "notes" TEXT,
    "needsPromptUpdate" BOOLEAN NOT NULL DEFAULT false,
    "needsFaqUpdate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentQualityReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyAgentMetrics" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "metricDate" TIMESTAMP(3) NOT NULL,
    "totalCalls" INTEGER NOT NULL DEFAULT 0,
    "resolvedCalls" INTEGER NOT NULL DEFAULT 0,
    "escalatedCalls" INTEGER NOT NULL DEFAULT 0,
    "avgDurationSeconds" DOUBLE PRECISION,
    "avgToolCalls" DOUBLE PRECISION,
    "avgToolLatencyMs" DOUBLE PRECISION,
    "fallbackRate" DOUBLE PRECISION,
    "resolutionRate" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyAgentMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallTranscript" (
    "id" TEXT NOT NULL,
    "callSessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "timestampMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadCapture" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "callSessionId" TEXT,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "intent" TEXT,
    "interestedItems" JSONB,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadCapture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckoutLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "callSessionId" TEXT,
    "checkoutFingerprint" TEXT,
    "shopifyConnectionId" TEXT,
    "mode" "CheckoutMode" NOT NULL DEFAULT 'STOREFRONT_CART',
    "checkoutUrl" TEXT NOT NULL,
    "customerEmail" TEXT,
    "itemsJson" JSONB,
    "status" "CheckoutLinkStatus" NOT NULL DEFAULT 'CREATED',
    "providerRef" TEXT,
    "expiresAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "callSessionId" TEXT,
    "checkoutLinkId" TEXT,
    "idempotencyKey" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'resend',
    "providerMessageId" TEXT,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "bodyPreview" TEXT,
    "metadata" JSONB,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCache" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "handle" TEXT,
    "title" TEXT NOT NULL,
    "vendor" TEXT,
    "productType" TEXT,
    "status" TEXT,
    "bodyHtml" TEXT,
    "tags" TEXT,
    "collectionsJson" JSONB,
    "rawJson" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantCache" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productCacheId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT,
    "price" DECIMAL(12,2),
    "compareAtPrice" DECIMAL(12,2),
    "inventoryQuantity" INTEGER,
    "availableForSale" BOOLEAN,
    "rawJson" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolExecution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "callSessionId" TEXT,
    "requestId" TEXT,
    "toolName" TEXT NOT NULL,
    "inputJson" JSONB NOT NULL,
    "outputJson" JSONB,
    "status" "ToolExecutionStatus" NOT NULL,
    "errorMessage" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "Client_tenantId_idx" ON "Client"("tenantId");

-- CreateIndex
CREATE INDEX "AgentType_tenantId_idx" ON "AgentType"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentType_tenantId_code_key" ON "AgentType"("tenantId", "code");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");

-- CreateIndex
CREATE INDEX "Store_tenantId_idx" ON "Store"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Store_tenantId_slug_key" ON "Store"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "BranchProfile_tenantId_idx" ON "BranchProfile"("tenantId");

-- CreateIndex
CREATE INDEX "BranchProfile_storeId_idx" ON "BranchProfile"("storeId");

-- CreateIndex
CREATE INDEX "BranchProfile_city_idx" ON "BranchProfile"("city");

-- CreateIndex
CREATE INDEX "StoreFAQ_tenantId_idx" ON "StoreFAQ"("tenantId");

-- CreateIndex
CREATE INDEX "StoreFAQ_storeId_idx" ON "StoreFAQ"("storeId");

-- CreateIndex
CREATE INDEX "StoreFAQ_branchProfileId_idx" ON "StoreFAQ"("branchProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyConnection_storeId_key" ON "ShopifyConnection"("storeId");

-- CreateIndex
CREATE INDEX "ShopifyConnection_tenantId_idx" ON "ShopifyConnection"("tenantId");

-- CreateIndex
CREATE INDEX "Agent_tenantId_idx" ON "Agent"("tenantId");

-- CreateIndex
CREATE INDEX "Agent_storeId_idx" ON "Agent"("storeId");

-- CreateIndex
CREATE INDEX "Agent_twilioPhoneNumber_idx" ON "Agent"("twilioPhoneNumber");

-- CreateIndex
CREATE INDEX "Agent_clientId_idx" ON "Agent"("clientId");

-- CreateIndex
CREATE INDEX "Agent_agentTypeId_idx" ON "Agent"("agentTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_tenantId_slug_key" ON "Agent"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "AgentConfig_agentId_key" ON "AgentConfig"("agentId");

-- CreateIndex
CREATE INDEX "AgentConfig_tenantId_idx" ON "AgentConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceProfile_agentId_key" ON "VoiceProfile"("agentId");

-- CreateIndex
CREATE INDEX "VoiceProfile_tenantId_idx" ON "VoiceProfile"("tenantId");

-- CreateIndex
CREATE INDEX "PhoneNumberMapping_tenantId_idx" ON "PhoneNumberMapping"("tenantId");

-- CreateIndex
CREATE INDEX "PhoneNumberMapping_agentId_idx" ON "PhoneNumberMapping"("agentId");

-- CreateIndex
CREATE INDEX "PhoneNumberMapping_phoneNumberId_idx" ON "PhoneNumberMapping"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneNumberMapping_tenantId_phoneNumber_key" ON "PhoneNumberMapping"("tenantId", "phoneNumber");

-- CreateIndex
CREATE INDEX "PhoneNumber_tenantId_idx" ON "PhoneNumber"("tenantId");

-- CreateIndex
CREATE INDEX "PhoneNumber_agentId_idx" ON "PhoneNumber"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneNumber_tenantId_twilioSid_key" ON "PhoneNumber"("tenantId", "twilioSid");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneNumber_tenantId_phoneNumber_key" ON "PhoneNumber"("tenantId", "phoneNumber");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_tenantId_idx" ON "KnowledgeDocument"("tenantId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_storeId_idx" ON "KnowledgeDocument"("storeId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_branchProfileId_idx" ON "KnowledgeDocument"("branchProfileId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_type_status_idx" ON "KnowledgeDocument"("type", "status");

-- CreateIndex
CREATE INDEX "KnowledgeSourceFile_tenantId_idx" ON "KnowledgeSourceFile"("tenantId");

-- CreateIndex
CREATE INDEX "KnowledgeSourceFile_storeId_idx" ON "KnowledgeSourceFile"("storeId");

-- CreateIndex
CREATE INDEX "KnowledgeSyncJob_tenantId_idx" ON "KnowledgeSyncJob"("tenantId");

-- CreateIndex
CREATE INDEX "KnowledgeSyncJob_storeId_idx" ON "KnowledgeSyncJob"("storeId");

-- CreateIndex
CREATE INDEX "KnowledgeSyncJob_status_idx" ON "KnowledgeSyncJob"("status");

-- CreateIndex
CREATE INDEX "PromptVersion_tenantId_idx" ON "PromptVersion"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_agentId_version_key" ON "PromptVersion"("agentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CallSession_twilioCallSid_key" ON "CallSession"("twilioCallSid");

-- CreateIndex
CREATE INDEX "CallSession_tenantId_idx" ON "CallSession"("tenantId");

-- CreateIndex
CREATE INDEX "CallSession_storeId_idx" ON "CallSession"("storeId");

-- CreateIndex
CREATE INDEX "CallSession_agentId_idx" ON "CallSession"("agentId");

-- CreateIndex
CREATE INDEX "CallSession_agentId_createdAt_idx" ON "CallSession"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "CallSession_phoneNumberId_idx" ON "CallSession"("phoneNumberId");

-- CreateIndex
CREATE INDEX "CallSession_twilioCallSid_idx" ON "CallSession"("twilioCallSid");

-- CreateIndex
CREATE INDEX "CallEvent_tenantId_idx" ON "CallEvent"("tenantId");

-- CreateIndex
CREATE INDEX "CallEvent_callSessionId_idx" ON "CallEvent"("callSessionId");

-- CreateIndex
CREATE INDEX "CallEvent_type_idx" ON "CallEvent"("type");

-- CreateIndex
CREATE INDEX "CallEvent_timestamp_idx" ON "CallEvent"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "CallOutcome_callSessionId_key" ON "CallOutcome"("callSessionId");

-- CreateIndex
CREATE INDEX "CallOutcome_tenantId_idx" ON "CallOutcome"("tenantId");

-- CreateIndex
CREATE INDEX "CallOutcome_resolutionStatus_idx" ON "CallOutcome"("resolutionStatus");

-- CreateIndex
CREATE INDEX "CallbackRequest_tenantId_idx" ON "CallbackRequest"("tenantId");

-- CreateIndex
CREATE INDEX "CallbackRequest_agentId_idx" ON "CallbackRequest"("agentId");

-- CreateIndex
CREATE INDEX "CallbackRequest_callSessionId_idx" ON "CallbackRequest"("callSessionId");

-- CreateIndex
CREATE INDEX "CallbackRequest_status_idx" ON "CallbackRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OrderBookingDraft_callSessionId_key" ON "OrderBookingDraft"("callSessionId");

-- CreateIndex
CREATE INDEX "OrderBookingDraft_tenantId_idx" ON "OrderBookingDraft"("tenantId");

-- CreateIndex
CREATE INDEX "OrderBookingDraft_agentId_idx" ON "OrderBookingDraft"("agentId");

-- CreateIndex
CREATE INDEX "OrderBookingDraft_status_idx" ON "OrderBookingDraft"("status");

-- CreateIndex
CREATE INDEX "AgentQualityReview_tenantId_idx" ON "AgentQualityReview"("tenantId");

-- CreateIndex
CREATE INDEX "AgentQualityReview_agentId_idx" ON "AgentQualityReview"("agentId");

-- CreateIndex
CREATE INDEX "AgentQualityReview_callSessionId_idx" ON "AgentQualityReview"("callSessionId");

-- CreateIndex
CREATE INDEX "DailyAgentMetrics_tenantId_idx" ON "DailyAgentMetrics"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyAgentMetrics_agentId_metricDate_key" ON "DailyAgentMetrics"("agentId", "metricDate");

-- CreateIndex
CREATE INDEX "CallTranscript_callSessionId_idx" ON "CallTranscript"("callSessionId");

-- CreateIndex
CREATE INDEX "CallTranscript_createdAt_idx" ON "CallTranscript"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallTranscript_callSessionId_sequenceNumber_key" ON "CallTranscript"("callSessionId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "LeadCapture_tenantId_idx" ON "LeadCapture"("tenantId");

-- CreateIndex
CREATE INDEX "LeadCapture_agentId_idx" ON "LeadCapture"("agentId");

-- CreateIndex
CREATE INDEX "LeadCapture_agentId_createdAt_idx" ON "LeadCapture"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadCapture_callSessionId_idx" ON "LeadCapture"("callSessionId");

-- CreateIndex
CREATE INDEX "CheckoutLink_tenantId_idx" ON "CheckoutLink"("tenantId");

-- CreateIndex
CREATE INDEX "CheckoutLink_agentId_idx" ON "CheckoutLink"("agentId");

-- CreateIndex
CREATE INDEX "CheckoutLink_agentId_createdAt_idx" ON "CheckoutLink"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "CheckoutLink_callSessionId_idx" ON "CheckoutLink"("callSessionId");

-- CreateIndex
CREATE INDEX "CheckoutLink_tenantId_agentId_callSessionId_checkoutFingerp_idx" ON "CheckoutLink"("tenantId", "agentId", "callSessionId", "checkoutFingerprint");

-- CreateIndex
CREATE INDEX "CheckoutLink_shopifyConnectionId_idx" ON "CheckoutLink"("shopifyConnectionId");

-- CreateIndex
CREATE INDEX "CheckoutLink_status_idx" ON "CheckoutLink"("status");

-- CreateIndex
CREATE INDEX "CheckoutLink_customerEmail_idx" ON "CheckoutLink"("customerEmail");

-- CreateIndex
CREATE INDEX "EmailEvent_tenantId_idx" ON "EmailEvent"("tenantId");

-- CreateIndex
CREATE INDEX "EmailEvent_agentId_idx" ON "EmailEvent"("agentId");

-- CreateIndex
CREATE INDEX "EmailEvent_agentId_createdAt_idx" ON "EmailEvent"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailEvent_callSessionId_idx" ON "EmailEvent"("callSessionId");

-- CreateIndex
CREATE INDEX "EmailEvent_checkoutLinkId_idx" ON "EmailEvent"("checkoutLinkId");

-- CreateIndex
CREATE INDEX "EmailEvent_recipientEmail_idx" ON "EmailEvent"("recipientEmail");

-- CreateIndex
CREATE INDEX "EmailEvent_status_idx" ON "EmailEvent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EmailEvent_tenantId_idempotencyKey_key" ON "EmailEvent"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ProductCache_tenantId_idx" ON "ProductCache"("tenantId");

-- CreateIndex
CREATE INDEX "ProductCache_shopDomain_idx" ON "ProductCache"("shopDomain");

-- CreateIndex
CREATE INDEX "ProductCache_title_idx" ON "ProductCache"("title");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCache_tenantId_shopifyProductId_key" ON "ProductCache"("tenantId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "VariantCache_tenantId_idx" ON "VariantCache"("tenantId");

-- CreateIndex
CREATE INDEX "VariantCache_sku_idx" ON "VariantCache"("sku");

-- CreateIndex
CREATE INDEX "VariantCache_title_idx" ON "VariantCache"("title");

-- CreateIndex
CREATE UNIQUE INDEX "VariantCache_tenantId_shopifyVariantId_key" ON "VariantCache"("tenantId", "shopifyVariantId");

-- CreateIndex
CREATE INDEX "ToolExecution_tenantId_idx" ON "ToolExecution"("tenantId");

-- CreateIndex
CREATE INDEX "ToolExecution_agentId_idx" ON "ToolExecution"("agentId");

-- CreateIndex
CREATE INDEX "ToolExecution_agentId_createdAt_idx" ON "ToolExecution"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolExecution_callSessionId_idx" ON "ToolExecution"("callSessionId");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_idx" ON "AuditLog"("tenantId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentType" ADD CONSTRAINT "AgentType_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchProfile" ADD CONSTRAINT "BranchProfile_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFAQ" ADD CONSTRAINT "StoreFAQ_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFAQ" ADD CONSTRAINT "StoreFAQ_branchProfileId_fkey" FOREIGN KEY ("branchProfileId") REFERENCES "BranchProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyConnection" ADD CONSTRAINT "ShopifyConnection_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_agentTypeId_fkey" FOREIGN KEY ("agentTypeId") REFERENCES "AgentType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConfig" ADD CONSTRAINT "AgentConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConfig" ADD CONSTRAINT "AgentConfig_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceProfile" ADD CONSTRAINT "VoiceProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceProfile" ADD CONSTRAINT "VoiceProfile_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumberMapping" ADD CONSTRAINT "PhoneNumberMapping_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumberMapping" ADD CONSTRAINT "PhoneNumberMapping_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumberMapping" ADD CONSTRAINT "PhoneNumberMapping_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_branchProfileId_fkey" FOREIGN KEY ("branchProfileId") REFERENCES "BranchProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "CallSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallOutcome" ADD CONSTRAINT "CallOutcome_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "CallSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallbackRequest" ADD CONSTRAINT "CallbackRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallbackRequest" ADD CONSTRAINT "CallbackRequest_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "CallSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderBookingDraft" ADD CONSTRAINT "OrderBookingDraft_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderBookingDraft" ADD CONSTRAINT "OrderBookingDraft_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "CallSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallTranscript" ADD CONSTRAINT "CallTranscript_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "CallSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadCapture" ADD CONSTRAINT "LeadCapture_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadCapture" ADD CONSTRAINT "LeadCapture_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadCapture" ADD CONSTRAINT "LeadCapture_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "CallSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutLink" ADD CONSTRAINT "CheckoutLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutLink" ADD CONSTRAINT "CheckoutLink_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutLink" ADD CONSTRAINT "CheckoutLink_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "CallSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutLink" ADD CONSTRAINT "CheckoutLink_shopifyConnectionId_fkey" FOREIGN KEY ("shopifyConnectionId") REFERENCES "ShopifyConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "CallSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_checkoutLinkId_fkey" FOREIGN KEY ("checkoutLinkId") REFERENCES "CheckoutLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCache" ADD CONSTRAINT "ProductCache_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantCache" ADD CONSTRAINT "VariantCache_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantCache" ADD CONSTRAINT "VariantCache_productCacheId_fkey" FOREIGN KEY ("productCacheId") REFERENCES "ProductCache"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "CallSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
