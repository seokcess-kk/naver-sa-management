-- Add CPC-first automation targets for search ad operations.
ALTER TABLE "BidAutomationConfig"
  ADD COLUMN "targetCpc" INTEGER,
  ADD COLUMN "maxCpc" INTEGER,
  ADD COLUMN "minCtr" DECIMAL(6, 4),
  ADD COLUMN "targetAvgRank" DECIMAL(5, 2);

