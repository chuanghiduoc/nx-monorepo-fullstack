-- Reverses the webhook tables. Dropping them takes their policies and grants.
DROP TABLE IF EXISTS "webhook_deliveries";
DROP TABLE IF EXISTS "webhook_endpoints";
