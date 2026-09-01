-- CreateTable
CREATE TABLE "demo_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "title" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "demo_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "demo_items_createdAt_id_idx" ON "demo_items"("createdAt" DESC, "id" DESC);
