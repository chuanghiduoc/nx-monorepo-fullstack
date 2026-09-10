-- Reverses the assistant's corpus. Dropping the tables takes their policies,
-- constraints, indexes and grants with them; `ai_chunks` goes first because it
-- holds the foreign key.
--
-- The `vector` extension is deliberately left in place. Dropping it would take
-- every other vector column in the database with it, and this migration is not
-- the only thing that may have created it.
DROP TABLE IF EXISTS "ai_chunks";
DROP TABLE IF EXISTS "ai_documents";
