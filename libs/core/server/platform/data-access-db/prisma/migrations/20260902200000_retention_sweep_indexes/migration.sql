-- CreateIndex
CREATE INDEX "idempotency_records_lease_until_idx" ON "idempotency_records"("lease_until");

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE INDEX "verification_expires_at_idx" ON "verification"("expires_at");
