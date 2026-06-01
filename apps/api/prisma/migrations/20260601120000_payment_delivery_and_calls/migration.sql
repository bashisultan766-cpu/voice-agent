-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "call_sid" TEXT NOT NULL,
    "caller_phone" TEXT NOT NULL,
    "twilio_number" TEXT NOT NULL,
    "caller_country" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_deliveries" (
    "id" TEXT NOT NULL,
    "call_sid" TEXT,
    "order_id" TEXT,
    "customer_email" TEXT NOT NULL,
    "customer_phone" TEXT,
    "country" TEXT,
    "payment_link" TEXT NOT NULL,
    "email_status" TEXT NOT NULL DEFAULT 'pending',
    "email_message_id" TEXT,
    "email_error" TEXT,
    "sms_status" TEXT NOT NULL DEFAULT 'pending',
    "sms_message_sid" TEXT,
    "sms_error" TEXT,
    "whatsapp_status" TEXT NOT NULL DEFAULT 'pending',
    "whatsapp_message_sid" TEXT,
    "whatsapp_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calls_call_sid_key" ON "calls"("call_sid");

-- CreateIndex
CREATE INDEX "calls_caller_phone_idx" ON "calls"("caller_phone");

-- CreateIndex
CREATE INDEX "calls_created_at_idx" ON "calls"("created_at");

-- CreateIndex
CREATE INDEX "payment_deliveries_call_sid_idx" ON "payment_deliveries"("call_sid");

-- CreateIndex
CREATE INDEX "payment_deliveries_order_id_idx" ON "payment_deliveries"("order_id");

-- CreateIndex
CREATE INDEX "payment_deliveries_customer_email_idx" ON "payment_deliveries"("customer_email");

-- CreateIndex
CREATE INDEX "payment_deliveries_created_at_idx" ON "payment_deliveries"("created_at");
