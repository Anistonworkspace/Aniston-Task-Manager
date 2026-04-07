-- Migration: Add dual authentication columns to users table
-- Enables Microsoft SSO users to also create a local password for email+password login

ALTER TABLE users ADD COLUMN IF NOT EXISTS has_local_password BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(255) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMP DEFAULT NULL;

-- Set has_local_password = true for existing local auth users who have a password
UPDATE users SET has_local_password = TRUE WHERE "authProvider" = 'local' AND password IS NOT NULL;
