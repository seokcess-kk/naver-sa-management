-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'operator', 'viewer');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "MasterAccountStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "AdvertiserStatus" AS ENUM ('active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('on', 'off', 'deleted');

-- CreateEnum
CREATE TYPE "AdGroupStatus" AS ENUM ('on', 'off', 'deleted');

-- CreateEnum
CREATE TYPE "KeywordStatus" AS ENUM ('on', 'off', 'deleted');

-- CreateEnum
CREATE TYPE "AdStatus" AS ENUM ('on', 'off', 'deleted');

-- CreateEnum
CREATE TYPE "AdExtensionStatus" AS ENUM ('on', 'off', 'deleted');

-- CreateEnum
CREATE TYPE "InspectStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "AdExtensionType" AS ENUM ('headline', 'description', 'image', 'pricelink', 'sublink', 'location', 'calculation', 'reservation', 'talktalk');

-- CreateEnum
CREATE TYPE "ChangeBatchStatus" AS ENUM ('pending', 'running', 'done', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "ChangeItemStatus" AS ENUM ('pending', 'running', 'done', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "StatLevel" AS ENUM ('campaign', 'adgroup', 'keyword');

-- CreateEnum
CREATE TYPE "StatDevice" AS ENUM ('PC', 'MOBILE');

-- CreateEnum
CREATE TYPE "AlertEventStatus" AS ENUM ('pending', 'sent', 'failed', 'muted');

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'viewer',
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserAdvertiserAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "grantedBy" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAdvertiserAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "apiKeyEnc" BYTEA NOT NULL,
    "apiKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "secretKeyEnc" BYTEA NOT NULL,
    "secretKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "MasterAccountStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MasterAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Advertiser" (
    "id" TEXT NOT NULL,
    "masterId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bizNo" TEXT,
    "category" TEXT,
    "manager" TEXT,
    "memo" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AdvertiserStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Advertiser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "nccCampaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "campaignType" TEXT,
    "dailyBudget" DECIMAL(14,2),
    "status" "CampaignStatus" NOT NULL DEFAULT 'on',
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdGroup" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "nccAdgroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bidAmt" INTEGER,
    "dailyBudget" DECIMAL(14,2),
    "pcChannelOn" BOOLEAN NOT NULL DEFAULT true,
    "mblChannelOn" BOOLEAN NOT NULL DEFAULT true,
    "status" "AdGroupStatus" NOT NULL DEFAULT 'on',
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Keyword" (
    "id" TEXT NOT NULL,
    "adgroupId" TEXT NOT NULL,
    "nccKeywordId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "matchType" TEXT,
    "bidAmt" INTEGER,
    "useGroupBidAmt" BOOLEAN NOT NULL DEFAULT true,
    "userLock" BOOLEAN NOT NULL DEFAULT false,
    "externalId" TEXT,
    "status" "KeywordStatus" NOT NULL DEFAULT 'on',
    "inspectStatus" "InspectStatus" NOT NULL DEFAULT 'pending',
    "recentAvgRnk" DECIMAL(5,2),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Keyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ad" (
    "id" TEXT NOT NULL,
    "adgroupId" TEXT NOT NULL,
    "nccAdId" TEXT NOT NULL,
    "adType" TEXT,
    "fields" JSONB,
    "inspectStatus" "InspectStatus" NOT NULL DEFAULT 'pending',
    "inspectMemo" TEXT,
    "status" "AdStatus" NOT NULL DEFAULT 'on',
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdExtension" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL DEFAULT 'adgroup',
    "nccExtId" TEXT NOT NULL,
    "type" "AdExtensionType" NOT NULL,
    "payload" JSONB NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "inspectStatus" "InspectStatus" NOT NULL DEFAULT 'pending',
    "inspectMemo" TEXT,
    "status" "AdExtensionStatus" NOT NULL DEFAULT 'on',
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdExtension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "status" "ChangeBatchStatus" NOT NULL DEFAULT 'pending',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ChangeBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "status" "ChangeItemStatus" NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChangeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "channelHint" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "AlertEventStatus" NOT NULL DEFAULT 'pending',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatDaily" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "level" "StatLevel" NOT NULL,
    "refId" TEXT NOT NULL,
    "device" "StatDevice" NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "avgRnk" DECIMAL(5,2),
    "conversions" INTEGER,
    "revenue" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAdvertiserAccess_advertiserId_idx" ON "UserAdvertiserAccess"("advertiserId");

-- CreateIndex
CREATE UNIQUE INDEX "UserAdvertiserAccess_userId_advertiserId_key" ON "UserAdvertiserAccess"("userId", "advertiserId");

-- CreateIndex
CREATE UNIQUE INDEX "MasterAccount_customerId_key" ON "MasterAccount"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Advertiser_customerId_key" ON "Advertiser"("customerId");

-- CreateIndex
CREATE INDEX "Advertiser_masterId_customerId_idx" ON "Advertiser"("masterId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_nccCampaignId_key" ON "Campaign"("nccCampaignId");

-- CreateIndex
CREATE INDEX "Campaign_advertiserId_idx" ON "Campaign"("advertiserId");

-- CreateIndex
CREATE UNIQUE INDEX "AdGroup_nccAdgroupId_key" ON "AdGroup"("nccAdgroupId");

-- CreateIndex
CREATE INDEX "AdGroup_campaignId_idx" ON "AdGroup"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "Keyword_nccKeywordId_key" ON "Keyword"("nccKeywordId");

-- CreateIndex
CREATE INDEX "Keyword_adgroupId_status_idx" ON "Keyword"("adgroupId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Ad_nccAdId_key" ON "Ad"("nccAdId");

-- CreateIndex
CREATE INDEX "Ad_adgroupId_idx" ON "Ad"("adgroupId");

-- CreateIndex
CREATE UNIQUE INDEX "AdExtension_nccExtId_key" ON "AdExtension"("nccExtId");

-- CreateIndex
CREATE INDEX "AdExtension_ownerId_type_idx" ON "AdExtension"("ownerId", "type");

-- CreateIndex
CREATE INDEX "ChangeBatch_status_leaseExpiresAt_idx" ON "ChangeBatch"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ChangeBatch_userId_idx" ON "ChangeBatch"("userId");

-- CreateIndex
CREATE INDEX "ChangeItem_batchId_status_idx" ON "ChangeItem"("batchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeItem_batchId_idempotencyKey_key" ON "ChangeItem"("batchId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AuditLog_userId_ts_idx" ON "AuditLog"("userId", "ts");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AlertEvent_ruleId_createdAt_idx" ON "AlertEvent"("ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "StatDaily_date_level_refId_idx" ON "StatDaily"("date", "level", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "StatDaily_date_level_refId_device_key" ON "StatDaily"("date", "level", "refId", "device");

-- AddForeignKey
ALTER TABLE "UserAdvertiserAccess" ADD CONSTRAINT "UserAdvertiserAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAdvertiserAccess" ADD CONSTRAINT "UserAdvertiserAccess_grantedBy_fkey" FOREIGN KEY ("grantedBy") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAdvertiserAccess" ADD CONSTRAINT "UserAdvertiserAccess_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Advertiser" ADD CONSTRAINT "Advertiser_masterId_fkey" FOREIGN KEY ("masterId") REFERENCES "MasterAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdGroup" ADD CONSTRAINT "AdGroup_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_adgroupId_fkey" FOREIGN KEY ("adgroupId") REFERENCES "AdGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_adgroupId_fkey" FOREIGN KEY ("adgroupId") REFERENCES "AdGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdExtension" ADD CONSTRAINT "AdExtension_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "AdGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeBatch" ADD CONSTRAINT "ChangeBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeItem" ADD CONSTRAINT "ChangeItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ChangeBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
