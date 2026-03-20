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
    if (origin && !origin.startsWith(allowed)) {
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
    message: 'Aniston Project Hub API is running.',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// ─── Rate limiting ──────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 login attempts per 15 min per IP
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

// ─── API routes ──────────────────────────────────────────────
app.use('/api', generalLimiter); // Apply to all API routes
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
app.use('/api', dependencyRoutes);
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

    // Sync models — create missing tables only, skip ALTER (Sequelize ALTER has bugs with REFERENCES)
    try {
      await sequelize.sync({ alter: false });
      console.log('[Server] Database models synced.');
    } catch (syncErr) {
      console.warn('[Server] DB sync warning (non-fatal):', syncErr.message?.slice(0, 100));
      console.log('[Server] Continuing with existing schema...');
    }

    server.listen(PORT, () => {
      const logger = require('./utils/logger');
      logger.info(`Aniston Project Hub API running on port ${PORT}`, { env: process.env.NODE_ENV || 'development' });
      console.log(`[Server] Aniston Project Hub API running on port ${PORT}`);
      console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[Server] Health check: http://localhost:${PORT}/api/health`);

      // Start reminder cron jobs
      const { startReminderJob } = require('./jobs/reminderJob');
      startReminderJob();

      // Start recurring task job
      const { startRecurringTaskJob } = require('./jobs/recurringTaskJob');
      startRecurringTaskJob();
    });
  } catch (error) {
    console.error('[Server] Failed to start:', error);
    process.exit(1);
  }
};

start();

module.exports = { app, server };
