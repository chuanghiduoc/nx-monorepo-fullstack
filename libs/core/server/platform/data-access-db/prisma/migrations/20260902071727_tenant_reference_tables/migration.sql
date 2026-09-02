-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookmarks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID,
    "user_id" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookmarks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notes_org_id_created_at_id_idx" ON "notes"("org_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "bookmarks_org_id_created_at_id_idx" ON "bookmarks"("org_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "bookmarks_user_id_created_at_id_idx" ON "bookmarks"("user_id", "created_at" DESC, "id" DESC);
