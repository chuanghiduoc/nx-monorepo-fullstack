-- CreateTable
CREATE TABLE "stored_files" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "declared_type" VARCHAR(255) NOT NULL,
    "detected_type" VARCHAR(255),
    "size_bytes" BIGINT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(512),
    "scan_attempts" INTEGER NOT NULL DEFAULT 0,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_at" TIMESTAMPTZ(3),

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stored_files_org_id_created_at_id_idx" ON "stored_files"("org_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "stored_files_status_created_at_idx" ON "stored_files"("status", "created_at");

-- Below is not expressible in the schema language.

-- The state machine, in the database rather than only in the repository.
ALTER TABLE "stored_files"
  ADD CONSTRAINT "stored_files_status"
  CHECK ("status" IN ('PENDING','UPLOADED','SCANNING','READY','REJECTED','QUARANTINED'));

-- A terminal state carries its reason, and a live one does not invent one.
-- Without this a rejection with no explanation is a support ticket nobody can
-- answer, and a `READY` file with a leftover reason reads as broken.
ALTER TABLE "stored_files"
  ADD CONSTRAINT "stored_files_reason_when_terminal"
  CHECK (
    ("status" IN ('REJECTED','QUARANTINED') AND "reason" IS NOT NULL)
    OR ("status" NOT IN ('REJECTED','QUARANTINED') AND "reason" IS NULL)
  );

-- A size the store reported, never a caller's claim, so it cannot be negative.
ALTER TABLE "stored_files"
  ADD CONSTRAINT "stored_files_size_nonneg"
  CHECK ("size_bytes" IS NULL OR "size_bytes" >= 0);

-- One record per object. The key is derived from the record's id, so a
-- duplicate here would mean two records claiming one object — and the cleanup
-- decides what to delete by asking whether an object has a record.
CREATE UNIQUE INDEX "stored_files_object_key_key" ON "stored_files"("object_key");

-- ---------------------------------------------------------------------------
-- Row-level security. TENANT_OWNED with the single-branch template, plus the
-- policy that names `worker_user` — the scanner runs in a system transaction
-- with no tenant set, and a table with no policy at all would be reachable by
-- `app_user` across every tenant.
-- ---------------------------------------------------------------------------
ALTER TABLE "stored_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stored_files" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "stored_files"
  USING ("org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY scanner ON "stored_files"
  FOR ALL TO worker_user USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Grants.
--
-- The state machine's owner is the worker, and this is what makes that true
-- rather than a convention: `app_user` may create a record and may say "the
-- upload finished", and it may do nothing else to the status. Those are two
-- columns, so the grant is column-level.
--
-- Without it, a request could mark its own file READY — skipping the type
-- check that is the entire point of the scan.
-- ---------------------------------------------------------------------------
REVOKE ALL ON "stored_files" FROM app_user, worker_user, cross_tenant_admin_role;

GRANT INSERT, SELECT ON "stored_files" TO app_user;
-- `status` so the API can move PENDING to UPLOADED and nothing further — the
-- repository's statement is what bounds *which* transition; the grant is what
-- stops every other column being rewritten. `uploaded_at` goes with it.
GRANT UPDATE ("status", "uploaded_at", "updated_at") ON "stored_files" TO app_user;
-- Deleting a record is how a tenant removes a file; the object is swept
-- afterwards by the worker, which is why the record goes first.
GRANT DELETE ON "stored_files" TO app_user;

-- The worker reads, scans, and moves the state wherever the machine allows.
GRANT SELECT, UPDATE, DELETE ON "stored_files" TO worker_user;

-- cross_tenant_admin_role gets nothing: a file's name and type are a tenant's
-- data, and the object behind it is more so.
