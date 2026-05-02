-- Migration: Per-user UI font-size preference
-- Stores one of four enum-like values used by the client to pick a typography
-- scale: 'compact' | 'default' | 'comfortable' | 'large'. NULL means "use the
-- app's global default" (which the client now ships as a slightly compact
-- 0.9375x scale, ~15px root).
--
-- Idempotent. Safe to re-run.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS font_size_preference VARCHAR(20) DEFAULT NULL;

-- Defensive constraint — server validates, but the DB also rejects bad values
-- so a misbehaving client can't poison the row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_font_size_preference_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_font_size_preference_check
      CHECK (font_size_preference IS NULL OR font_size_preference IN ('compact','default','comfortable','large'));
  END IF;
END $$;
