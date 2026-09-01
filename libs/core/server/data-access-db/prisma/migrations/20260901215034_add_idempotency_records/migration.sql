-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "scopeType" VARCHAR(16) NOT NULL,
    "scopeId" VARCHAR(64) NOT NULL,
    "route" VARCHAR(200) NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMPTZ(6) NOT NULL,
    "fenceToken" INTEGER NOT NULL DEFAULT 1,
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_records_completedAt_idx" ON "idempotency_records"("completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_scopeType_scopeId_route_idempotencyKey_key" ON "idempotency_records"("scopeType", "scopeId", "route", "idempotencyKey");
