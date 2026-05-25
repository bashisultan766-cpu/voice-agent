-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "voiceNameLabel" TEXT;

-- AlterTable
ALTER TABLE "AgentConfig" ADD COLUMN     "emailReplyTo" TEXT,
ADD COLUMN     "emailSenderAddress" TEXT,
ADD COLUMN     "emailSenderName" TEXT,
ADD COLUMN     "emailSubjectTemplate" TEXT,
ADD COLUMN     "emailTestRecipient" TEXT,
ADD COLUMN     "paymentLinkEmailIntro" TEXT,
ADD COLUMN     "useWorkspaceEmail" BOOLEAN NOT NULL DEFAULT true;
