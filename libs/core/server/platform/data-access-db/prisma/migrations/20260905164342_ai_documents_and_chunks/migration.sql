-- The vector type has to exist before a column can be declared with it, so
-- this comes first. `pgvector/pgvector:pg18` ships the extension; the plain
-- `postgres:18` images do not, which is why the compose files and the test
-- harness all name that image.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "ai_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "source" VARCHAR(1024),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_chunks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_documents_org_id_created_at_id_idx" ON "ai_documents"("org_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ai_chunks_org_id_document_id_ordinal_idx" ON "ai_chunks"("org_id", "document_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "ai_chunks_document_id_ordinal_key" ON "ai_chunks"("document_id", "ordinal");

-- AddForeignKey
ALTER TABLE "ai_chunks" ADD CONSTRAINT "ai_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ai_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Below is not expressible in the schema language.

-- ---------------------------------------------------------------------------
-- The similarity index.
--
-- HNSW rather than IVFFlat. IVFFlat needs a training pass over a corpus that
-- resembles the real one, and a boilerplate's corpus is empty on the day it is
-- created — exactly when IVFFlat is at its worst, because its lists are built
-- from whatever happens to be there.
--
-- Cosine distance (`<=>`), which is what text embeddings are compared with.
-- The operator class and the operator in the query must agree: `ORDER BY
-- embedding <-> $1` against a cosine index does not use the index, it does a
-- sequential scan, and nothing says so.
--
-- Not `CONCURRENTLY`: that is for an index added to a table that already has
-- rows and readers. This table is created in the same migration, has neither,
-- and a Prisma migration is one transaction — which `CONCURRENTLY` cannot run
-- inside.
-- ---------------------------------------------------------------------------
CREATE INDEX "ai_chunks_embedding_hnsw"
  ON "ai_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Row-level security. TENANT_OWNED with the single-branch template.
--
-- A vector search that crossed organizations would be the quietest leak in the
-- system: it returns somebody else's text as context, and the model repeats it
-- in an answer that looks entirely normal.
-- ---------------------------------------------------------------------------
ALTER TABLE "ai_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_documents" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ai_documents"
  USING ("org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "ai_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_chunks" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ai_chunks"
  USING ("org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- What is *not* enforced here, said plainly: nothing stops a chunk being filed
-- under one organization while pointing at another's document. A foreign key
-- is checked as the table's owner and so does not see the policy above, and
-- the composite key that would express it — (document_id, org_id) referencing
-- (id, org_id) — is not expressible in the schema language, so it would show
-- up as drift against every `migrate diff`.
--
-- It is left out because it guards nothing: writing such a chunk requires
-- already knowing another organization's document id, and reading it back
-- returns only the text the writer supplied. The policy above is what keeps
-- one organization's passages out of another's search, and that is the
-- property that matters.

-- ---------------------------------------------------------------------------
-- Grants.
--
-- Ingesting and searching both happen on the request path, so the application
-- role does all of it. The worker gets nothing: no job here reads or writes
-- these tables, and a grant nothing uses is a grant nobody notices going wrong.
-- ---------------------------------------------------------------------------
REVOKE ALL ON "ai_documents", "ai_chunks" FROM app_user, worker_user, cross_tenant_admin_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_documents" TO app_user;
GRANT SELECT, INSERT, DELETE ON "ai_chunks" TO app_user;

-- cross_tenant_admin_role gets nothing: a document's text is a tenant's data,
-- and so is every passage cut from it.
