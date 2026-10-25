-- CapFeePolicy is unique on (tenantId, productId), not on productId alone.
--
-- CapFeePolicy_productId_key made productId globally unique, so two rows
-- cannot already share (tenantId, productId) while that index is present.
-- This migration still counts those pairs and aborts if any exist, in case
-- the old index was removed outside this history. It does not merge rows.
--
-- A policy whose tenantId differs from Product.tenantId (or whose product
-- is missing) is conflicting cross-tenant data. This migration does not
-- repair it: rewriting tenantId would attach the fee rule to the wrong
-- merchant, and deleting the row would drop a fee rule with no operator
-- decision. Either case raises and rolls the migration back, leaving both
-- indexes unchanged.
--
-- After the global unique is dropped, (tenant B, product of tenant A) would
-- be allowed by the composite key. The trigger below is the same fail-loud
-- rule for later writes: the row is rejected, not rewritten. savePolicy
-- must also refuse a product the caller does not own before it upserts.

DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM "CapFeePolicy" p
  LEFT JOIN "Product" prod ON prod.id = p."productId"
  WHERE prod.id IS NULL OR prod."tenantId" IS DISTINCT FROM p."tenantId";
  IF bad > 0 THEN
    RAISE EXCEPTION
      'CapFeePolicy tenant mismatch: % row(s) have tenantId different from Product.tenantId or a missing product. Not dropping CapFeePolicy_productId_key and not rewriting or deleting those rows.',
      bad;
  END IF;

  SELECT count(*) INTO bad FROM (
    SELECT 1
    FROM "CapFeePolicy"
    GROUP BY "tenantId", "productId"
    HAVING count(*) > 1
  ) d;
  IF bad > 0 THEN
    RAISE EXCEPTION
      'CapFeePolicy composite duplicates: % (tenantId, productId) pair(s) already repeat. Not changing uniqueness and not merging rows.',
      bad;
  END IF;
END $$;

DROP INDEX IF EXISTS "CapFeePolicy_productId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "CapFeePolicy_tenantId_productId_key"
  ON "CapFeePolicy" ("tenantId", "productId");

CREATE OR REPLACE FUNCTION cap_fee_policy_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  product_tenant text;
BEGIN
  SELECT "tenantId" INTO product_tenant FROM "Product" WHERE id = NEW."productId";
  IF product_tenant IS NULL THEN
    RAISE EXCEPTION 'CapFeePolicy product % does not exist', NEW."productId";
  END IF;
  IF product_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'CapFeePolicy tenantId % does not match product tenant %', NEW."tenantId", product_tenant;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cap_fee_policy_same_tenant ON "CapFeePolicy";
CREATE TRIGGER cap_fee_policy_same_tenant
  BEFORE INSERT OR UPDATE OF "tenantId", "productId" ON "CapFeePolicy"
  FOR EACH ROW EXECUTE FUNCTION cap_fee_policy_same_tenant();
