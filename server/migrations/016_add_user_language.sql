-- Migration: Per-user UI language preference
-- Stores an ISO 639-1 code that drives the client-side i18n provider. Only
-- 'en' and 'hi' are accepted today; adding a new locale means updating both
-- the CHECK constraint below AND the matching Sequelize validator on the
-- User model. NULL means "use the app default" (English).
--
-- Idempotent. Safe to re-run.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS language VARCHAR(8) DEFAULT NULL;

-- Defensive CHECK so a misbehaving client / hand-written SQL can't poison
-- the column with values the client cannot render.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_language_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_language_check
      CHECK (language IS NULL OR language IN ('en','hi'));
  END IF;
END $$;
