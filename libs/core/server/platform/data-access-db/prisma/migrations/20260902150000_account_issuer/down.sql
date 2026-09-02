-- Down migration for 20260902150000_account_issuer.
--
-- Dropping the column loses the issuer of every account. That is correct here:
-- the value is derived from provider_id, which stays, so re-applying the up
-- migration reconstructs it exactly.

DROP INDEX "account_issuer_account_id_key";

ALTER TABLE "account" DROP COLUMN "issuer";
