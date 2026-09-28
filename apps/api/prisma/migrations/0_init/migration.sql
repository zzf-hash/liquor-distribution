-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'REP', 'CLERK', 'WAREHOUSE', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "DataScope" AS ENUM ('ALL', 'SELF', 'OWN_CUSTOMERS', 'SELF_ORDER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('BAIJIU', 'PIJIU', 'HONGJIU', 'YANGJIU', 'YINLIAO', 'QITA');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ON_SALE', 'OFF_SALE');

-- CreateEnum
CREATE TYPE "PriceLevelType" AS ENUM ('COST', 'TIER1', 'TIER2', 'TERMINAL', 'RETAIL');

-- CreateEnum
CREATE TYPE "PriceUnit" AS ENUM ('BASE', 'MIN');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('YANJIUDIAN', 'CHAOSHI', 'CANYIN', 'PIFA', 'YECHANG', 'QIYE', 'QITA');

-- CreateEnum
CREATE TYPE "SettlementType" AS ENUM ('CASH', 'MONTHLY');

-- CreateEnum
CREATE TYPE "SignMode" AS ENUM ('E_SIGN', 'PAPER');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('REP_DRAFT', 'CLERK_CONFIRMED', 'PENDING_OWNER', 'ACTIVE', 'REJECTED');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('OK', 'PENDING');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "InventoryRefType" AS ENUM ('INITIAL_IMPORT', 'OUTBOUND', 'REJECT_RETURN', 'REVERSAL_IN', 'ADJUST');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('CLERK', 'REP', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_CONFIRM', 'CONFIRMED', 'OUTBOUND', 'DELIVERING', 'SIGNED', 'SETTLED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OrderPriceType" AS ENUM ('CUSTOMER_EXCLUSIVE', 'TIER1', 'TIER2', 'TERMINAL', 'RETAIL', 'SPECIAL', 'MANUAL');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('CREDIT_RELEASE', 'PRICE_SPECIAL', 'ORDER_SPECIAL');

-- CreateEnum
CREATE TYPE "ApprovalResult" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OutboundStatus" AS ENUM ('PICKING', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "SignatureType" AS ENUM ('E_SIGN', 'PHOTO', 'PAPER');

-- CreateEnum
CREATE TYPE "ReceivableSourceType" AS ENUM ('ORDER', 'INITIAL');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('REPORTED', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ArLedgerDirection" AS ENUM ('CHARGE', 'SETTLE', 'REBATE_OFFSET', 'WAIVE', 'WRITEOFF', 'REVERSAL');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('PAYMENT', 'WAIVE', 'BAD_DEBT');

-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('PRODUCT', 'CUSTOMER', 'PRICE', 'INVENTORY', 'RECEIVABLE');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'PREVIEWED', 'COMMITTED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ImportRowLevel" AS ENUM ('REJECT_BATCH', 'REJECT_ROW', 'WARN');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "dataScope" "DataScope" NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "phone" TEXT,
    "customerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "skuCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ProductCategory" NOT NULL,
    "brand" TEXT,
    "baseUnit" TEXT NOT NULL,
    "minUnit" TEXT NOT NULL DEFAULT '瓶',
    "packSize" INTEGER NOT NULL,
    "barcode" TEXT,
    "abv" DOUBLE PRECISION,
    "origin" TEXT,
    "supplier" TEXT,
    "specText" TEXT,
    "highValue" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProductStatus" NOT NULL DEFAULT 'ON_SALE',
    "pinyinFirst" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Price" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unit" "PriceUnit" NOT NULL,
    "levelType" "PriceLevelType" NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "approvalRef" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPrice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unit" "PriceUnit" NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "approvalRef" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CustomerType" NOT NULL,
    "contact" TEXT,
    "phone" TEXT NOT NULL,
    "region" TEXT,
    "address" TEXT NOT NULL,
    "abcLevel" TEXT,
    "settlement" "SettlementType" NOT NULL DEFAULT 'MONTHLY',
    "termsDays" INTEGER NOT NULL DEFAULT 30,
    "creditLimit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "minOrderAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "receivingWindow" TEXT,
    "signMode" "SignMode" NOT NULL DEFAULT 'E_SIGN',
    "printerModel" TEXT,
    "salespersonId" TEXT,
    "bossPhone" TEXT,
    "licenseNo" TEXT,
    "licenseStatus" "LicenseStatus" NOT NULL DEFAULT 'PENDING',
    "onboarding" "OnboardingStatus" NOT NULL DEFAULT 'REP_DRAFT',
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchStock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "produceDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "location" TEXT,
    "unitCost" DECIMAL(12,4) NOT NULL,
    "snapshotDate" TIMESTAMP(3),
    "isInitial" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLedger" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "refType" "InventoryRefType" NOT NULL,
    "refNo" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "salespersonId" TEXT,
    "source" "OrderSource" NOT NULL,
    "signMode" "SignMode" NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "addressSnapshot" TEXT NOT NULL,
    "deliveryDate" TIMESTAMP(3),
    "precheck" JSONB,
    "specialApproved" BOOLEAN NOT NULL DEFAULT false,
    "cancelReason" TEXT,
    "createdById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "outboundAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "specText" TEXT,
    "unit" "PriceUnit" NOT NULL,
    "conversionRate" INTEGER NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "priceType" "OrderPriceType" NOT NULL,
    "priceVersion" TEXT NOT NULL,
    "promoNote" TEXT,
    "isGift" BOOLEAN NOT NULL DEFAULT false,
    "reversalOfId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "ApprovalType" NOT NULL,
    "amount" DECIMAL(12,2),
    "reason" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "result" "ApprovalResult" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outbound" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outboundNo" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "OutboundStatus" NOT NULL DEFAULT 'PICKING',
    "pickerId" TEXT,
    "checkerId" TEXT,
    "note" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Outbound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outboundId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "OutboundLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignatureRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "SignatureType" NOT NULL,
    "signerName" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "photoUrl" TEXT,
    "signatureData" TEXT,
    "deviceInfo" TEXT,
    "recordedById" TEXT NOT NULL,
    "returnPackages" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignatureRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receivable" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceType" "ReceivableSourceType" NOT NULL,
    "sourceDocNo" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disputeFlag" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receivable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "paymentNo" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "kind" "PaymentKind" NOT NULL DEFAULT 'PAYMENT',
    "receivableId" TEXT,
    "method" TEXT,
    "voucher" TEXT,
    "reportedById" TEXT,
    "enteredById" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'REPORTED',
    "idemKey" TEXT,
    "note" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivableLedger" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "receivableId" TEXT NOT NULL,
    "paymentId" TEXT,
    "direction" "ArLedgerDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivableLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "username" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'web',
    "prevRowHash" TEXT NOT NULL,
    "rowHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "passedRows" INTEGER NOT NULL DEFAULT 0,
    "rejectedRows" INTEGER NOT NULL DEFAULT 0,
    "warnedRows" INTEGER NOT NULL DEFAULT 0,
    "snapshotDate" TIMESTAMP(3),
    "report" JSONB,
    "createdBy" TEXT NOT NULL,
    "committedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRowError" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNo" INTEGER NOT NULL,
    "rowKey" TEXT,
    "level" "ImportRowLevel" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "raw" JSONB,

    CONSTRAINT "ImportRowError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseSummary" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "note" TEXT,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_code_key" ON "Tenant"("code");

-- CreateIndex
CREATE INDEX "User_tenantId_role_idx" ON "User"("tenantId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_username_key" ON "User"("tenantId", "username");

-- CreateIndex
CREATE INDEX "Product_tenantId_name_idx" ON "Product"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Product_tenantId_category_idx" ON "Product"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_skuCode_key" ON "Product"("tenantId", "skuCode");

-- CreateIndex
CREATE INDEX "Price_tenantId_productId_validFrom_idx" ON "Price"("tenantId", "productId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Price_tenantId_productId_unit_levelType_validFrom_key" ON "Price"("tenantId", "productId", "unit", "levelType", "validFrom");

-- CreateIndex
CREATE INDEX "CustomerPrice_tenantId_customerId_productId_idx" ON "CustomerPrice"("tenantId", "customerId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPrice_tenantId_customerId_productId_unit_validFrom_key" ON "CustomerPrice"("tenantId", "customerId", "productId", "unit", "validFrom");

-- CreateIndex
CREATE INDEX "Customer_tenantId_name_idx" ON "Customer"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Customer_tenantId_salespersonId_idx" ON "Customer"("tenantId", "salespersonId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_tenantId_code_key" ON "Customer"("tenantId", "code");

-- CreateIndex
CREATE INDEX "BatchStock_tenantId_productId_idx" ON "BatchStock"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchStock_tenantId_productId_batchNo_key" ON "BatchStock"("tenantId", "productId", "batchNo");

-- CreateIndex
CREATE INDEX "InventoryLedger_tenantId_productId_createdAt_idx" ON "InventoryLedger"("tenantId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryLedger_tenantId_refType_refNo_idx" ON "InventoryLedger"("tenantId", "refType", "refNo");

-- CreateIndex
CREATE INDEX "SalesOrder_tenantId_status_idx" ON "SalesOrder"("tenantId", "status");

-- CreateIndex
CREATE INDEX "SalesOrder_tenantId_customerId_idx" ON "SalesOrder"("tenantId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_tenantId_orderNo_key" ON "SalesOrder"("tenantId", "orderNo");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_tenantId_id_key" ON "SalesOrder"("tenantId", "id");

-- CreateIndex
CREATE INDEX "OrderLine_tenantId_orderId_idx" ON "OrderLine"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "OrderLine_reversalOfId_idx" ON "OrderLine"("reversalOfId");

-- CreateIndex
CREATE INDEX "ApprovalRecord_tenantId_orderId_idx" ON "ApprovalRecord"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "Outbound_tenantId_orderId_idx" ON "Outbound"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Outbound_tenantId_outboundNo_key" ON "Outbound"("tenantId", "outboundNo");

-- CreateIndex
CREATE INDEX "OutboundLine_tenantId_outboundId_idx" ON "OutboundLine"("tenantId", "outboundId");

-- CreateIndex
CREATE UNIQUE INDEX "SignatureRecord_tenantId_orderId_key" ON "SignatureRecord"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "Receivable_tenantId_customerId_dueDate_idx" ON "Receivable"("tenantId", "customerId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Receivable_tenantId_sourceType_sourceDocNo_key" ON "Receivable"("tenantId", "sourceType", "sourceDocNo");

-- CreateIndex
CREATE INDEX "Payment_tenantId_customerId_idx" ON "Payment"("tenantId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_paymentNo_key" ON "Payment"("tenantId", "paymentNo");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_idemKey_key" ON "Payment"("tenantId", "idemKey");

-- CreateIndex
CREATE INDEX "ReceivableLedger_tenantId_receivableId_createdAt_idx" ON "ReceivableLedger"("tenantId", "receivableId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_entityType_entityId_idx" ON "AuditLog"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_userId_createdAt_idx" ON "AuditLog"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportBatch_tenantId_kind_status_idx" ON "ImportBatch"("tenantId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_tenantId_batchNo_key" ON "ImportBatch"("tenantId", "batchNo");

-- CreateIndex
CREATE INDEX "ImportRowError_tenantId_batchId_idx" ON "ImportRowError"("tenantId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_tenantId_key_key" ON "IdempotencyRecord"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "SystemConfig_tenantId_key_key" ON "SystemConfig"("tenantId", "key");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Price" ADD CONSTRAINT "Price_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPrice" ADD CONSTRAINT "CustomerPrice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPrice" ADD CONSTRAINT "CustomerPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_salespersonId_fkey" FOREIGN KEY ("salespersonId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchStock" ADD CONSTRAINT "BatchStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedger" ADD CONSTRAINT "InventoryLedger_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedger" ADD CONSTRAINT "InventoryLedger_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BatchStock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "OrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outbound" ADD CONSTRAINT "Outbound_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundLine" ADD CONSTRAINT "OutboundLine_outboundId_fkey" FOREIGN KEY ("outboundId") REFERENCES "Outbound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundLine" ADD CONSTRAINT "OutboundLine_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundLine" ADD CONSTRAINT "OutboundLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BatchStock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignatureRecord" ADD CONSTRAINT "SignatureRecord_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "SalesOrder"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_tenantId_sourceDocNo_fkey" FOREIGN KEY ("tenantId", "sourceDocNo") REFERENCES "SalesOrder"("tenantId", "orderNo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivableLedger" ADD CONSTRAINT "ReceivableLedger_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "Receivable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivableLedger" ADD CONSTRAINT "ReceivableLedger_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRowError" ADD CONSTRAINT "ImportRowError_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════ 安全基线 DB 层加固 (安全评审-01) ═══════════
-- B2/B4 append-only: 撤销 UPDATE/DELETE/TRUNCATE(仅 INSERT+SELECT)
-- 注意: compose 的 POSTGRES_USER=liquor 是表 owner; 生产收紧(专用低权限角色+RLS FORCE)
--       步骤与验收用例见文末注释。
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "InventoryLedger" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "ReceivableLedger" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "OrderLine" FROM PUBLIC;          -- B3 写一次
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "SignatureRecord" FROM PUBLIC;    -- P1-6
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "ApprovalRecord" FROM PUBLIC;

-- B5 第二层(P1-4): 租户 RLS 策略(键=会话 GUC app.tenant_id; FORCE 启用步骤见部署收紧单)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['User','Product','Price','CustomerPrice','Customer','BatchStock',
    'InventoryLedger','SalesOrder','OrderLine','Outbound','OutboundLine','SignatureRecord',
    'Receivable','Payment','ReceivableLedger','AuditLog','ApprovalRecord','ImportBatch',
    'ImportRowError','IdempotencyRecord','SystemConfig']
  LOOP
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END $$;
