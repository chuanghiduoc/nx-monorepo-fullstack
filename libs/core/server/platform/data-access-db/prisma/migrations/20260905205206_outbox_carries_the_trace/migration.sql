-- The trace the request that caused an event was in.
--
-- Nullable, and it has to be: every row written before this column existed has
-- no trace, and so does every event a schedule caused. A NOT NULL with a
-- default would be a default that lies — a `traceparent` pointing at a trace
-- that never existed is worse than none, because a reader follows it.
--
-- `app_user` already holds INSERT on this table and column-level grants were
-- never used here, so nothing further is needed for the API to write it.

-- `prisma migrate dev` wrote `DROP INDEX "ai_chunks_embedding_hnsw"` here and
-- it has been removed by hand. The generator diffs against `schema.prisma`,
-- which has no way to declare an HNSW index, so every migration it writes from
-- now on will propose dropping the vector index — and applying that once would
-- turn every similarity search into a sequential scan with nothing to say so.
--
-- The drift test knows about the same gap and asserts that this exact statement
-- is the *only* difference, so a real drift still fails.

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "trace_parent" VARCHAR(64);
