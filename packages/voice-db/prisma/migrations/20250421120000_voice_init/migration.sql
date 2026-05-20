-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "VoiceCallStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "CallbackStatus" AS ENUM ('OPEN', 'CONTACTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "store_settings" (
    "id" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "greeting" TEXT,
    "timezone" TEXT DEFAULT 'America/New_York',
    "hoursJson" JSONB,
    "shippingPolicy" TEXT,
    "returnsPolicy" TEXT,
    "storePolicyNotes" TEXT,
    "escalationPhone" TEXT,
    "shopifyDomain" TEXT,
    "shopifyAdminToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_items" (
    "id" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "category" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faq_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_logs" (
    "id" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "twilioCallSid" TEXT,
    "twilioSessionId" TEXT,
    "fromNumber" TEXT,
    "toNumber" TEXT,
    "status" "VoiceCallStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "transcript" TEXT,
    "actionsJson" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "callback_bookings" (
    "id" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "preferredTime" TEXT NOT NULL,
    "notes" TEXT,
    "status" "CallbackStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "callback_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_settings_storeKey_key" ON "store_settings"("storeKey");

-- CreateIndex
CREATE UNIQUE INDEX "call_logs_twilioCallSid_key" ON "call_logs"("twilioCallSid");

-- CreateIndex
CREATE INDEX "faq_items_storeKey_idx" ON "faq_items"("storeKey");

-- CreateIndex
CREATE INDEX "faq_items_storeKey_isActive_idx" ON "faq_items"("storeKey", "isActive");

-- CreateIndex
CREATE INDEX "call_logs_storeKey_idx" ON "call_logs"("storeKey");

-- CreateIndex
CREATE INDEX "call_logs_startedAt_idx" ON "call_logs"("startedAt");

-- CreateIndex
CREATE INDEX "callback_bookings_storeKey_idx" ON "callback_bookings"("storeKey");

-- CreateIndex
CREATE INDEX "callback_bookings_status_idx" ON "callback_bookings"("status");

-- AddForeignKey
ALTER TABLE "faq_items" ADD CONSTRAINT "faq_items_storeKey_fkey" FOREIGN KEY ("storeKey") REFERENCES "store_settings"("storeKey") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_storeKey_fkey" FOREIGN KEY ("storeKey") REFERENCES "store_settings"("storeKey") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "callback_bookings" ADD CONSTRAINT "callback_bookings_storeKey_fkey" FOREIGN KEY ("storeKey") REFERENCES "store_settings"("storeKey") ON DELETE CASCADE ON UPDATE CASCADE;
