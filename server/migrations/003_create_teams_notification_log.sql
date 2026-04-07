-- Migration: Teams Notification System
-- Adds teams_notifications_enabled to users table
-- Creates teams_notification_log table for audit + duplicate prevention

-- 1. User preference for Teams notifications
ALTER TABLE users ADD COLUMN IF NOT EXISTS teams_notifications_enabled BOOLEAN DEFAULT TRUE;

-- 2. Notification log table
CREATE TABLE IF NOT EXISTS teams_notification_log (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(100) UNIQUE NOT NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES users(id),
    notification_type VARCHAR(50) NOT NULL,
    card_payload JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    sent_at TIMESTAMP DEFAULT NULL,
    error_message TEXT DEFAULT NULL,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 3. Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_teams_notif_event ON teams_notification_log(event_id);
CREATE INDEX IF NOT EXISTS idx_teams_notif_task ON teams_notification_log(task_id);
CREATE INDEX IF NOT EXISTS idx_teams_notif_user ON teams_notification_log(user_id);
CREATE INDEX IF NOT EXISTS idx_teams_notif_status ON teams_notification_log(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_teams_notif_type ON teams_notification_log(notification_type);
