const http = require('http');
const path = require('path');
require('dotenv').config();

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
const directorPlanRoutes = require('./routes/directorPlan');
const archiveRoutes = require('./routes/archive');
const pushRoutes = require('./routes/push');
const externalRoutes = require('./routes/external');
const integrationConfigRoutes = require('./routes/integrationConfig');
const noteRoutes = require('./routes/notes');
const feedbackRoutes = require('./routes/feedback');
const aiRoutes = require('./routes/ai');

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
  allowedHeaders: ['Content-Type', 'Authorization'],
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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
app.use('/api/director-plan', directorPlanRoutes);
app.use('/api/archive', archiveRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/integrations', integrationConfigRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/ai', aiRoutes);

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

    // Extend task status ENUM with new values (safe to re-run — IF NOT EXISTS)
    const newStatuses = ['ready_to_start', 'in_progress', 'waiting_for_review', 'pending_deploy', 'review'];
    for (const val of newStatuses) {
      try {
        await sequelize.query(`ALTER TYPE "enum_tasks_status" ADD VALUE IF NOT EXISTS '${val}';`);
      } catch (e) {
        // Ignore — type may not exist yet or value already exists
      }
    }
    console.log('[Server] Status ENUM migration complete.');

    // Extend user role ENUM with assistant_manager (safe to re-run)
    try {
      await sequelize.query(`ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'assistant_manager';`);
      console.log('[Server] User role ENUM migration complete.');
    } catch (e) {
      // Ignore — type may not exist yet or value already exists
    }

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

    // Sync models — create missing tables only, skip ALTER (Sequelize ALTER has bugs with REFERENCES)
    try {
      await sequelize.sync({ alter: false });
      console.log('[Server] Database models synced.');
    } catch (syncErr) {
      console.warn('[Server] DB sync warning (non-fatal):', syncErr.message?.slice(0, 100));
      console.log('[Server] Continuing with existing schema...');
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
