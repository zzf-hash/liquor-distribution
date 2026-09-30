-- CreateEnum
CREATE TYPE "StockAlertLevel" AS ENUM ('OK', 'LOW', 'OUT');

-- CreateEnum
CREATE TYPE "RestockStatus" AS ENUM ('PENDING_CLERK', 'SUBMITTED', 'APPROVED', 'DISMISSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "DailyStockReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportDate" DATE NOT NULL,
    "productId" TEXT NOT NULL,
    "onHand" DECIMAL(14,3) NOT NULL,
    "baseQty" DECIMAL(14,3) NOT NULL,
    "sold3d" DECIMAL(14,3) NOT NULL,
    "sold7d" DECIMAL(14,3) NOT NULL,
    "soldWindow" DECIMAL(14,3) NOT NULL,
    "dailyAvg" DECIMAL(14,3) NOT NULL,
    "thresholdQty" DECIMAL(14,3) NOT NULL,
    "inTransitQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "suggestedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "level" "StockAlertLevel" NOT NULL DEFAULT 'OK',
    "stockValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "restockStatus" TEXT,
    "restockId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyStockReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestockRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "baseQty" DECIMAL(14,3) NOT NULL,
    "onHand" DECIMAL(14,3) NOT NULL,
    "thresholdQty" DECIMAL(14,3) NOT NULL,
    "dailyAvg" DECIMAL(14,3) NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "status" "RestockStatus" NOT NULL DEFAULT 'PENDING_CLERK',
    "purchaseId" TEXT,
    "approvalId" TEXT,
    "snapshot" JSONB,
    "dismissedBy" TEXT,
    "dismissReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestockRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyStockReport_restockId_key" ON "DailyStockReport"("restockId");

-- CreateIndex
CREATE INDEX "DailyStockReport_tenantId_reportDate_level_idx" ON "DailyStockReport"("tenantId", "reportDate", "level");

-- CreateIndex
CREATE UNIQUE INDEX "DailyStockReport_tenantId_reportDate_productId_key" ON "DailyStockReport"("tenantId", "reportDate", "productId");

-- CreateIndex
CREATE INDEX "RestockRequest_tenantId_status_idx" ON "RestockRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "RestockRequest_tenantId_productId_status_idx" ON "RestockRequest"("tenantId", "productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RestockRequest_tenantId_requestId_key" ON "RestockRequest"("tenantId", "requestId");

-- AddForeignKey
ALTER TABLE "DailyStockReport" ADD CONSTRAINT "DailyStockReport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyStockReport" ADD CONSTRAINT "DailyStockReport_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyStockReport" ADD CONSTRAINT "DailyStockReport_restockId_fkey" FOREIGN KEY ("restockId") REFERENCES "RestockRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestockRequest" ADD CONSTRAINT "RestockRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestockRequest" ADD CONSTRAINT "RestockRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

