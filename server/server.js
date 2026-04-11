const http = require('http');
const path = require('path');
require('dotenv').config();
// Multi-manager support: ManagerRelation model + routes added (nodemon restart trigger)

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

// Validate critical environment variables
if (!process.env.JWT_SECRET) {
  console.error('[Fatal] JWT_SECRET environment variable is not set. Please configure it in .env');
  process.exit(1);
}

const { testConnection } = require('./config/db');
const { sequelize } = require('./models');
const { initializeSocket } = require('./services/socketService');

// ─── Route imports ───────────────────────────────────────────
const authRoutes = require('./routes/auth');
const boardRoutes = require('./routes/boards');
const taskRoutes = require('./routes/tasks');
const commentRoutes = require('./routes/comments');
const fileRoutes = require('./routes/files');
const notificationRoutes = require('./routes/notifications');
const webhookRoutes = require('./routes/webhooks');
const subtaskRoutes = require('./routes/subtasks');
const worklogRoutes = require('./routes/worklogs');
const activityRoutes = require('./routes/activities');
const dashboardRoutes = require('./routes/dashboard');
const userRoutes = require('./routes/users');
const timePlanRoutes = require('./routes/timeplans');
const reviewRoutes = require('./routes/reviews');
const searchRoutes = require('./routes/search');
const departmentRoutes = require('./routes/departments');
const meetingRoutes = require('./routes/meetings');
const dependencyRoutes = require('./routes/dependencies');
const teamsRoutes = require('./routes/teams');
const automationRoutes = require('./routes/automations');
const workspaceRoutes = require('./routes/workspaces');
const permissionRoutes = require('./routes/permissions');
const accessRequestRoutes = require('./routes/accessRequests');
const taskExtrasRoutes = require('./routes/taskExtras');
const announcementRoutes = require('./routes/announcements');
const labelRoutes = require('./routes/labels');
const extensionRoutes = require('./routes/extensions');
const helpRequestRoutes = require('./routes/helpRequests');
const promotionRoutes = require('./routes/promotions');
const hierarchyRoutes = require('./routes/hierarchy');
const managerRelationRoutes = require('./routes/managerRelations');
const directorPlanRoutes = require('./routes/directorPlan');
const archiveRoutes = require('./routes/archive');
const pushRoutes = require('./routes/push');
const externalRoutes = require('./routes/external');
const integrationConfigRoutes = require('./routes/integrationConfig');
const noteRoutes = require('./routes/notes');
const feedbackRoutes = require('./routes/feedback');
const aiRoutes = require('./routes/ai');
const apiKeyRoutes = require('./routes/apiKeys');

// ─── App initialisation ─────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── Socket.io initialisation ────────────────────────────────
initializeSocket(server);

// ─── Global middleware ───────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Origin validation (CSRF-like protection for mutating requests) ──
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin || req.headers.referer;
    const allowed = process.env.CLIENT_URL || 'http://localhost:3000';
    if (origin && origin !== allowed) {
      return res.status(403).json({ success: false, message: 'Request origin not allowed' });
    }
    next();
  });
}

// ─── Static file serving (uploads) ──────────────────────────
// Serves locally stored files.  In production, consider adding
// authentication middleware here or switching to signed URLs.
const { getUploadDir } = require('./middleware/upload');
app.use('/uploads', express.static(getUploadDir()));

// ─── Upload config endpoint (tells frontend what's allowed) ─
const { UPLOAD_CATEGORIES } = require('./config/fileTypes');
app.get('/api/upload-config', (req, res) => {
  const configs = {};
  for (const [key, cat] of Object.entries(UPLOAD_CATEGORIES)) {
    configs[key] = {
      label: cat.label,
      extensions: cat.extensions,
      accept: cat.extensions.map(e => `.${e}`).join(','),
      maxSizeMB: cat.maxSizeMB || 25,
    };
  }
  res.json({ success: true, data: configs });
});

// ─── Health check ────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'Monday Aniston API is running.',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// ─── Rate limiting ──────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 login attempts per 15 min per IP (increased for shared office networks)
  message: { success: false, message: 'Too many login attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // 50 uploads per 15 min
  message: { success: false, message: 'Too many file uploads. Please try again later.' },
});

const searchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 searches per minute
  message: { success: false, message: 'Too many search requests. Please slow down.' },
});

// General API rate limiter (200 requests per minute per IP)
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  message: { success: false, message: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// External/HRMS API rate limiter (100 requests per minute per IP)
const externalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many external API requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── API routes ──────────────────────────────────────────────
app.use('/api', generalLimiter); // Apply to all API routes

// External HRMS API (must be before dependency routes which apply global authenticate)
app.use('/api/external', externalLimiter, externalRoutes);

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/boards', boardRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/files', uploadLimiter, fileRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/subtasks', subtaskRoutes);
app.use('/api/worklogs', worklogRoutes);
app.use('/api/activities', activityRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/users', userRoutes);
app.use('/api/timeplans', timePlanRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/search', searchLimiter, searchRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/teams', teamsRoutes);
app.use('/api/automations', automationRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/permissions', permissionRoutes);
app.use('/api/access-requests', accessRequestRoutes);
app.use('/api/task-extras', taskExtrasRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/labels', labelRoutes);
app.use('/api/extensions', extensionRoutes);
app.use('/api/help-requests', helpRequestRoutes);
app.use('/api/promotions', promotionRoutes);
app.use('/api/hierarchy-levels', hierarchyRoutes);
app.use('/api/manager-relations', managerRelationRoutes);
app.use('/api/director-plan', directorPlanRoutes);
app.use('/api/archive', archiveRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/integrations', integrationConfigRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/api-keys', apiKeyRoutes);

// ─── Multi-manager relation routes (inline for reliable loading) ───
const { authenticate: mrAuth, managerOrAdmin: mrMgr } = require('./middleware/auth');
const mrCtrl = require('./controllers/managerRelationController');
app.get('/api/multi-manager/:employeeId', mrAuth, mrCtrl.getRelationsForEmployee);
app.post('/api/multi-manager', mrAuth, mrMgr, mrCtrl.addRelation);
app.put('/api/multi-manager/:id', mrAuth, mrMgr, mrCtrl.updateRelation);
app.delete('/api/multi-manager/:id', mrAuth, mrMgr, mrCtrl.removeRelation);
app.post('/api/multi-manager/sync', mrAuth, mrMgr, mrCtrl.syncFromManagerId);

// Dependency routes mounted at /api (uses router.use(authenticate) — must be LAST)
app.use('/api', dependencyRoutes);

// ─── 404 handler ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found.',
  });
});

// ─── Global error handler ────────────────────────────────────
const logger = require('./utils/logger');
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, name: err.name });

  // Sequelize validation errors
  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    const messages = err.errors.map((e) => e.message);
    return res.status(400).json({
      success: false,
      message: 'Validation error.',
      errors: messages,
    });
  }

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: process.env.NODE_ENV === 'production'
      ? 'Internal server error.'
      : err.message || 'Internal server error.',
  });
});

// ─── Start server ────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 5000;

const start = async () => {
  try {
    // Test DB connection
    await testConnection();

    // ── Auto-migration: Convert tasks.status from ENUM to VARCHAR(50) ──
    // This is required for custom task-level statuses. Safe to re-run.
    try {
      const [colInfo] = await sequelize.query(
        `SELECT data_type, udt_name FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'status'`
      );
      if (colInfo.length > 0 && colInfo[0].data_type === 'USER-DEFINED') {
        console.log('[Server] Converting tasks.status from ENUM to VARCHAR(50)...');
        await sequelize.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status_new VARCHAR(50)`);
        await sequelize.query(`UPDATE tasks SET status_new = status::text WHERE status_new IS NULL`);
        await sequelize.query(`ALTER TABLE tasks DROP COLUMN status`);
        await sequelize.query(`ALTER TABLE tasks RENAME COLUMN status_new TO status`);
        await sequelize.query(`ALTER TABLE tasks ALTER COLUMN status SET NOT NULL`);
        await sequelize.query(`ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'not_started'`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status)`);
        await sequelize.query(`DROP TYPE IF EXISTS "enum_tasks_status"`);
        console.log('[Server] tasks.status converted to VARCHAR(50) successfully.');
      } else {
        console.log('[Server] tasks.status is already VARCHAR — no ENUM conversion needed.');
      }
    } catch (e) {
      console.warn('[Server] Status ENUM migration warning:', e.message?.slice(0, 120));
    }

    // ── Auto-migration: Add statusConfig JSONB column to tasks ──
    try {
      await sequelize.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "statusConfig" JSONB DEFAULT NULL`);
      console.log('[Server] tasks.statusConfig column ensured.');
    } catch (e) {
      console.warn('[Server] statusConfig column migration warning:', e.message?.slice(0, 100));
    }

    // Extend user role ENUM with assistant_manager (safe to re-run)
    try {
      await sequelize.query(`ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'assistant_manager';`);
      console.log('[Server] User role ENUM migration complete.');
    } catch (e) {
      // Ignore — type may not exist yet or value already exists
    }

    // Create task_reminders table for deadline reminder tracking
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS task_reminders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "reminderType" VARCHAR(20) NOT NULL,
        "scheduledFor" TIMESTAMP WITH TIME ZONE NOT NULL,
        "sentAt" TIMESTAMP WITH TIME ZONE DEFAULT NULL,
        cancelled BOOLEAN DEFAULT false,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CONSTRAINT idx_task_reminder_unique UNIQUE("taskId", "reminderType")
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_task_reminder_pending ON task_reminders("scheduledFor") WHERE "sentAt" IS NULL AND cancelled = false`);
      console.log('[Server] task_reminders table ensured.');
    } catch (e) {
      console.warn('[Server] task_reminders migration warning:', e.message?.slice(0, 100));
    }

    // Extend notification type ENUM with deadline reminder types
    for (const val of ['deadline_2day', 'deadline_2hour']) {
      try {
        await sequelize.query(`ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS '${val}';`);
      } catch (e) { /* already exists or type not created yet */ }
    }
    console.log('[Server] Notification type ENUM extended for deadline reminders.');

    // Create task_owners table for multi-owner support
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS task_owners (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "isPrimary" BOOLEAN DEFAULT false,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE("taskId", "userId")
      )`);
      console.log('[Server] task_owners table ensured.');
    } catch (e) {
      console.warn('[Server] task_owners migration warning:', e.message?.slice(0, 100));
    }

    // Create task_assignee_role enum and task_assignees table for multi-assignee + supervisor support
    try {
      await sequelize.query(`DO $$ BEGIN CREATE TYPE task_assignee_role AS ENUM ('assignee', 'supervisor'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
      await sequelize.query(`CREATE TABLE IF NOT EXISTS task_assignees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role task_assignee_role NOT NULL DEFAULT 'assignee',
        "assignedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_assignees_task_user_role ON task_assignees("taskId", "userId", role)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_task_assignees_user_id ON task_assignees("userId")`);
      // Migrate existing assignedTo data into task_assignees (idempotent)
      await sequelize.query(`
        INSERT INTO task_assignees ("taskId", "userId", role, "assignedAt", "createdAt", "updatedAt")
        SELECT t.id, t."assignedTo", 'assignee', COALESCE(t."createdAt", NOW()), NOW(), NOW()
        FROM tasks t WHERE t."assignedTo" IS NOT NULL
        ON CONFLICT ("taskId", "userId", role) DO NOTHING
      `);
      // Also migrate task_owners entries
      await sequelize.query(`
        INSERT INTO task_assignees ("taskId", "userId", role, "assignedAt", "createdAt", "updatedAt")
        SELECT o."taskId", o."userId", 'assignee', COALESCE(o."createdAt", NOW()), NOW(), NOW()
        FROM task_owners o WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = o."taskId")
        ON CONFLICT ("taskId", "userId", role) DO NOTHING
      `);
      console.log('[Server] task_assignees table ensured and data migrated.');
    } catch (e) {
      console.warn('[Server] task_assignees migration warning:', e.message?.slice(0, 100));
    }

    // Sync models — create missing tables only, skip ALTER (Sequelize ALTER has bugs with REFERENCES)
    try {
      await sequelize.sync({ alter: false });
      console.log('[Server] Database models synced.');
    } catch (syncErr) {
      console.warn('[Server] DB sync warning (non-fatal):', syncErr.message?.slice(0, 100));
      console.log('[Server] Continuing with existing schema...');
    }

    // ── Auto-migration: Add lang column to notes table ──
    // Must run AFTER sync so the table exists. Uses IF NOT EXISTS for idempotency.
    try {
      // Check if the notes table exists first
      const [tables] = await sequelize.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'notes'`
      );
      if (tables.length > 0) {
        await sequelize.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS lang VARCHAR(10) DEFAULT 'en-US'`);
        console.log('[Server] notes.lang column ensured.');
      } else {
        console.log('[Server] notes table does not exist yet — lang column will be created with table.');
      }
    } catch (e) {
      console.warn('[Server] notes.lang migration warning:', e.message?.slice(0, 100));
    }

    // Create performance indices on frequently queried columns (safe to re-run)
    const indices = [
      'CREATE INDEX IF NOT EXISTS idx_tasks_board_id ON tasks("boardId")',
      'CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks("assignedTo")',
      'CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks("dueDate")',
      'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks("createdBy")',
      'CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications("userId")',
      'CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications("isRead")',
      'CREATE INDEX IF NOT EXISTS idx_activities_task_id ON activities("taskId")',
      'CREATE INDEX IF NOT EXISTS idx_activities_board_id ON activities("boardId")',
      'CREATE INDEX IF NOT EXISTS idx_task_owners_task_id ON task_owners("taskId")',
      'CREATE INDEX IF NOT EXISTS idx_task_owners_user_id ON task_owners("userId")',
    ];
    for (const sql of indices) {
      try { await sequelize.query(sql); } catch (e) { /* table may not exist yet */ }
    }
    console.log('[Server] Database indices ensured.');

    // Migrate legacy AIConfig records to AIProvider table (fire-and-forget)
    try {
      const { migrateFromLegacy } = require('./services/aiService');
      migrateFromLegacy();
    } catch (migErr) {
      console.warn('[Server] AI migration skipped:', migErr.message?.slice(0, 80));
    }

    server.listen(PORT, () => {
      const logger = require('./utils/logger');
      logger.info(`Monday Aniston API running on port ${PORT}`, { env: process.env.NODE_ENV || 'development' });
      console.log(`[Server] Monday Aniston API running on port ${PORT}`);
      console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[Server] Health check: http://localhost:${PORT}/api/health`);

      // Start reminder cron jobs
      const { startReminderJob } = require('./jobs/reminderJob');
      startReminderJob();

      // Start recurring task job
      const { startRecurringTaskJob } = require('./jobs/recurringTaskJob');
      startRecurringTaskJob();

      // Start director plan deadline notification job (every 30 minutes)
      const cron = require('node-cron');
      const { checkDirectorPlanDeadlines } = require('./services/deadlineNotificationService');
      cron.schedule('*/30 * * * *', async () => {
        try {
          await checkDirectorPlanDeadlines();
        } catch (err) {
          console.error('[DeadlineNotification] Cron job error:', err.message);
        }
      });
      console.log('[Server] Director plan deadline notification cron started (every 30 min)');

      // Start deadline reminder job (every 15 minutes)
      const { startDeadlineReminderJob } = require('./jobs/deadlineReminderJob');
      startDeadlineReminderJob();

      // Start priority escalation job (daily at midnight)
      const { startPriorityEscalationJob } = require('./jobs/priorityEscalationJob');
      startPriorityEscalationJob();
    });
  } catch (error) {
    console.error('[Server] Failed to start:', error);
    // Try to start the HTTP server anyway so health checks can report status
    try {
      server.listen(PORT, () => {
        console.error(`[Server] Started on port ${PORT} with errors — check logs above`);
      });
    } catch (listenErr) {
      console.error('[Server] Cannot start HTTP server:', listenErr);
      process.exit(1);
    }
  }
};

// Global handlers to prevent silent crashes in production
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled Promise Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err);
});

start();

module.exports = { app, server };
