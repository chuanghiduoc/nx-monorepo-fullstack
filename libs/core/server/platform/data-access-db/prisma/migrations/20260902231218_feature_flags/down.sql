-- Reverses the feature-flag tables. Dropping them takes their policies and
-- their grants with them.
DROP TABLE IF EXISTS "flag_overrides";
DROP TABLE IF EXISTS "feature_flags";
