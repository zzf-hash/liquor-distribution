-- B组 费用域: Expense 台账 + CapFeePolicy 开瓶费政策 + CapRecycleOrder 瓶盖回收 + FEE_OFFSET 冲抵方向

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('OFFICE', 'FUEL_TOLL', 'REPAIR', 'HANDLING', 'UTILITY', 'DISPLAY', 'ENTRY', 'CAP_FEE', 'OTHER');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExpensePayMode" AS ENUM ('CASH', 'AR_OFFSET');

-- CreateEnum
CREATE TYPE "CapRecycleStatus" AS ENUM ('PENDING_CONFIRM', 'CONFIRMED', 'CANCELLED');

-- AlterEnum: 费用冲抵方向(陈列/进店/开瓶费冲减货款; PG16 支持事务内 ADD VALUE, 同事务不使用新值)
ALTER TYPE "ArLedgerDirection" ADD VALUE IF NOT EXISTS 'FEE_OFFSET';

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "expenseNo" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "customerId" TEXT,
    "payee" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payMode" "ExpensePayMode" NOT NULL DEFAULT 'CASH',
    "status" "ExpenseStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approvalId" TEXT,
    "voucherUrl" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "paidNote" TEXT,
    "note" TEXT,
    "source" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapFeePolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "perBottleFee" DECIMAL(10,4) NOT NULL,
    "requireCap" BOOLEAN NOT NULL DEFAULT true,
    "noCapRate" DECIMAL(5,4) NOT NULL DEFAULT 1,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapFeePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapRecycleOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recycleNo" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "CapRecycleStatus" NOT NULL DEFAULT 'PENDING_CONFIRM',
    "lines" JSONB NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "expenseId" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapRecycleOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Expense_tenantId_expenseNo_key" ON "Expense"("tenantId", "expenseNo");

-- CreateIndex
CREATE INDEX "Expense_tenantId_category_occurredAt_idx" ON "Expense"("tenantId", "category", "occurredAt");

-- CreateIndex
CREATE INDEX "Expense_tenantId_status_idx" ON "Expense"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CapFeePolicy_productId_key" ON "CapFeePolicy"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "CapFeePolicy_tenantId_productId_key" ON "CapFeePolicy"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CapRecycleOrder_tenantId_recycleNo_key" ON "CapRecycleOrder"("tenantId", "recycleNo");

-- CreateIndex
CREATE INDEX "CapRecycleOrder_tenantId_status_createdAt_idx" ON "CapRecycleOrder"("tenantId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_customer_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_createdBy_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapFeePolicy" ADD CONSTRAINT "CapFeePolicy_product_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapRecycleOrder" ADD CONSTRAINT "CapRecycleOrder_customer_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
