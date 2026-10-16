-- C组: 返利坎级阶梯+现金形式 / 买N送M促销引擎 / 批量调价批次号+客户价联动结果

-- AlterEnum
ALTER TYPE "RebateSettleType" ADD VALUE IF NOT EXISTS 'CASH';

-- AlterEnum: 返利现金走费用域付款通道
ALTER TYPE "ExpenseCategory" ADD VALUE IF NOT EXISTS 'REBATE';

-- CreateEnum
CREATE TYPE "PromotionKind" AS ENUM ('BUY_N_GET_M');

-- AlterTable: 返利坎级阶梯
ALTER TABLE "RebateScheme" ADD COLUMN "tiers" JSONB;

-- AlterTable: 批量调价批次 + 客户价联动结果
ALTER TABLE "PriceChangeRequest" ADD COLUMN "batchNo" TEXT,
ADD COLUMN "customerSyncResult" JSONB;

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "PromotionKind" NOT NULL DEFAULT 'BUY_N_GET_M',
    "productId" TEXT NOT NULL,
    "giftProductId" TEXT,
    "buyQty" INTEGER NOT NULL,
    "giftQty" INTEGER NOT NULL,
    "unit" "PriceUnit" NOT NULL DEFAULT 'BASE',
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Promotion_tenantId_productId_idx" ON "Promotion"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "PriceChangeRequest_tenantId_batchNo_idx" ON "PriceChangeRequest"("tenantId", "batchNo");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_product_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_giftProduct_fkey" FOREIGN KEY ("giftProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
