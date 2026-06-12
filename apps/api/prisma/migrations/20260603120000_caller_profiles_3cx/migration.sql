-- CreateTable
CREATE TABLE "caller_profiles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "phone_normalized" TEXT NOT NULL,
    "phone_digits" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "email" TEXT,
    "company" TEXT,
    "source" TEXT NOT NULL,
    "external_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "caller_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "caller_profiles_phone_normalized_key" ON "caller_profiles"("phone_normalized");

-- CreateIndex
CREATE INDEX "caller_profiles_phone_digits_idx" ON "caller_profiles"("phone_digits");

-- CreateIndex
CREATE INDEX "caller_profiles_tenant_id_idx" ON "caller_profiles"("tenant_id");
