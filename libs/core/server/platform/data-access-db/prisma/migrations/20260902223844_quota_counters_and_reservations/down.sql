-- Reverses the quota tables.
--
-- Dropping a table takes its policies, its constraints and its grants with it,
-- so there is nothing to revoke separately here — unlike the audit migration,
-- which also granted a column on a table it did not create.
DROP TABLE IF EXISTS "quota_reservations";
DROP TABLE IF EXISTS "org_quota_counters";
