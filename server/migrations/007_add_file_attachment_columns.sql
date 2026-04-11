-- Migration: Add provider and category columns to file_attachments
-- These columns were added to the Sequelize model but never synced to the DB
-- because server.js uses sync({ alter: false }).

ALTER TABLE file_attachments ADD COLUMN IF NOT EXISTS provider VARCHAR(50) NOT NULL DEFAULT 'local';
ALTER TABLE file_attachments ADD COLUMN IF NOT EXISTS category VARCHAR(50) NOT NULL DEFAULT 'task_attachment';
