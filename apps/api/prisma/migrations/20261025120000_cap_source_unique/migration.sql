-- LQ1-008 / LQ1-020: one fee document per bottle-cap recycle and per customer-month accrual.
-- Partial index so ordinary MANUAL (and NULL) sources can repeat.
CREATE UNIQUE INDEX "Expense_cap_source_uidx"
ON "Expense" ("tenantId", "source")
WHERE "source" LIKE 'CAP_RECYCLE:%' OR "source" LIKE 'CAP_ACCRUAL:%';
