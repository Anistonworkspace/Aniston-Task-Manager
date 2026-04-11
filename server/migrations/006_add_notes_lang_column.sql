-- Migration: Add lang column to notes table
-- This column stores the BCP-47 language tag used for speech-to-text (e.g. 'en-US', 'hi-IN')

ALTER TABLE notes ADD COLUMN IF NOT EXISTS lang VARCHAR(10) DEFAULT 'en-US';
