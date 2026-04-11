-- Migration: Permission Override System
-- Adds action-based permission overrides to permission_grants table
-- Run this via: node server/migrations/run_008.js

-- Make permissionLevel nullable (new grants use action instead)
ALTER TABLE permission_grants ALTER COLUMN "permissionLevel" DROP NOT NULL;
ALTER TABLE permission_grants ALTER COLUMN "permissionLevel" SET DEFAULT NULL;

-- Add 'action' column for granular action-based permissions
ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS action VARCHAR(50);

-- Add 'revokedAt' for tracking when a permission was revoked
ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP WITH TIME ZONE;

-- Add 'revokedBy' for tracking who revoked
ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS "revokedBy" UUID REFERENCES users(id);

-- Add 'reason' for documenting why permission was granted
ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS reason TEXT;

-- Add 'scope' for resource-specific scoping (global, workspace-specific, board-specific)
ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS scope VARCHAR(20) DEFAULT 'global';

-- Add 'isOverride' flag to distinguish base grants from override grants
ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS "isOverride" BOOLEAN DEFAULT true;

-- Update resourceType to support new resource types
-- (STRING(50) is already wide enough, no ALTER needed for type)

-- Add index for action-based lookups
CREATE INDEX IF NOT EXISTS idx_permission_grants_action ON permission_grants(action);
CREATE INDEX IF NOT EXISTS idx_permission_grants_resource_action ON permission_grants("resourceType", action);
CREATE INDEX IF NOT EXISTS idx_permission_grants_user_resource_action ON permission_grants("userId", "resourceType", action);

-- Migrate existing permission_grants to new format
-- Existing grants with permissionLevel but no action get mapped to equivalent actions
-- This preserves backward compatibility
UPDATE permission_grants
SET action = "permissionLevel", scope = 'global', "isOverride" = true
WHERE action IS NULL AND "permissionLevel" IS NOT NULL;
