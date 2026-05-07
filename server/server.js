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
const archiveRoutes = require('./routes/archive');
const pushRoutes = require('./routes/push');
const externalRoutes = require('./routes/external');
const integrationConfigRoutes = require('./routes/integrationConfig');
const noteRoutes = require('./routes/notes');
const feedbackRoutes = require('./routes/feedback');
const aiRoutes = require('./routes/ai');
const transcriptionRoutes = require('./routes/transcriptionProviders');
const apiKeyRoutes = require('./routes/apiKeys');
const outboundWebhookRoutes = require('./routes/outboundWebhooks');
const recurringTaskRoutes = require('./routes/recurringTasks');
const boardOrderRoutes = require('./routes/boardOrders');
const systemSettingsRoutes = require('./routes/systemSettings');

// ─── App initialisation ─────────────────────────────────────
const app = express();

// Trust private-network proxies in front of the app.
//
// Production topology has TWO proxies: host nginx (terminates TLS on :443)
// → frontend container nginx (proxies /api/ to backend container). With the
// previous `trust proxy: 1`, Express only stripped one hop from the right of
// X-Forwarded-For, so req.ip resolved to the Docker bridge gateway (e.g.
// 172.19.0.1) for every request. That meant express-rate-limit bucketed
// EVERY user under the same key — one stuck browser tab DoS'd the whole
// product, and `combined`-format access logs only ever showed the bridge IP.
//
// Trusting the standard private-IP ranges (loopback / link-local / unique-
// local — see RFC 1918 + RFC 4193) walks XFF from right to left, skips every
// trusted proxy, and uses the first non-private IP as req.ip. That is the
// real public client IP regardless of how many internal hops are added.
//
// Local dev (no proxy) still works: with no XFF header set, req.ip falls
// back to the connection address (127.0.0.1).
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

const server = http.createServer(app);

// ─── Socket.io initialisation ────────────────────────────────
initializeSocket(server);

// ─── Meeting-mode audio streaming WebSocket ──────────────────
// Proxies browser PCM audio to Deepgram and forwards speaker-labeled
// transcripts back. Claims only /api/meeting-stream/ws so it coexists
// with Socket.io (which handles /socket.io/*).
const { attachMeetingStream } = require('./services/meetingStreamService');
attachMeetingStream(server);

// ─── Global middleware ───────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS origin policy.
//
// CLIENT_URL may carry a comma-separated list (e.g. for staging that admits
// both https://app.example.com and https://stg.example.com). We validate
// every entry at startup so a misconfigured value can never silently widen
// the policy in production.
//
// Rules:
//   - Wildcards ('*' anywhere in any entry) are REJECTED in production. They
//     are allowed in development for ergonomic local testing only.
//   - Missing / empty CLIENT_URL falls back to localhost:3000 in development
//     and FAILS startup in production (don't ship a permissive default).
//   - Each entry must be a parseable URL with http or https protocol.
const allowedOrigins = (() => {
  const raw = process.env.CLIENT_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000');
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'production') {
    if (list.length === 0) {
      console.error('[Fatal] CLIENT_URL is required in production (no permissive default).');
      process.exit(1);
    }
    for (const o of list) {
      if (o.includes('*')) {
        console.error(`[Fatal] CLIENT_URL contains wildcard "${o}" — refusing to start.`);
        process.exit(1);
      }
      try {
        const u = new URL(o);
        if (!/^https?:$/.test(u.protocol)) {
          console.error(`[Fatal] CLIENT_URL entry "${o}" must use http:// or https://.`);
          process.exit(1);
        }
      } catch {
        console.error(`[Fatal] CLIENT_URL entry "${o}" is not a valid URL.`);
        process.exit(1);
      }
    }
  }
  return list;
})();

app.use(cors({
  // Function form so we can support multiple allowed origins. Any non-CORS
  // request (no Origin header, e.g. curl/server-to-server) is allowed because
  // those requests aren't subject to the SOP CORS check anyway.
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, true); // dev fallback
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origin "${origin}" not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Capture the raw request buffer so signature-checking middleware (D-3 webhook
// HMAC verification) can compute HMAC over the EXACT bytes that arrived,
// not the JSON re-serialisation. Keeping a reference adds at most 10 MiB of
// retained memory per in-flight request, which is bounded by the body limit
// itself and dropped at the end of the request lifecycle. Other middleware
// MUST treat req.rawBody as immutable.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Origin validation (CSRF-like protection for mutating requests) ──────
// Runs in every environment except 'test'. The previous code only enforced
// in production, which meant a developer typo like "I'll just point this at
// `CLIENT_URL=*`" would never surface until prod boot — by which point the
// permissive value might already be merged. Validating in dev too forces the
// envvar to be correct earlier.
//
// We compare against the parsed `allowedOrigins` list (set above by the CORS
// block) and normalise the request side to a bare scheme://host:port so
// `Referer` URLs that include a path don't false-negative against an origin
// list of bare URLs.
if (process.env.NODE_ENV !== 'test') {
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const raw = req.headers.origin || req.headers.referer;
    if (!raw) return next(); // server-to-server / curl — not subject to SOP

    let candidate;
    try {
      const u = new URL(raw);
      candidate = `${u.protocol}//${u.host}`;
    } catch {
      // Malformed Origin/Referer — refuse rather than silently allow.
      return res.status(403).json({ success: false, message: 'Malformed Origin/Referer header.' });
    }

    // Empty allowed list = development fallback; permit the request.
    if (allowedOrigins.length === 0) return next();
    if (allowedOrigins.includes(candidate)) return next();
    return res.status(403).json({ success: false, message: 'Request origin not allowed' });
  });
}

// ─── Static file serving (uploads) ──────────────────────────
// Phase 5e (audit P0-1): /uploads is now AUTHENTICATED. Token is accepted
// via Authorization: Bearer header OR ?token= query string so <img src=...>
// tags still work once the frontend appends the JWT. Anonymous requests
// receive 401. Per-file authorization remains a follow-up; this is the
// baseline gate that closes the public-file-by-filename-guess vulnerability.
const { getUploadDir } = require('./middleware/upload');
const { authenticateForStatic } = require('./middleware/staticAuth');
app.use('/uploads', authenticateForStatic, express.static(getUploadDir()));

// ─── Upload config endpoint (tells frontend what's allowed) ─
// INTENTIONALLY PUBLIC — returns only file extension/size limits (no secrets).
// Frontend needs this before uploads to show allowed formats, even on login page.
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

// ─── Health checks ───────────────────────────────────────────
// /api/health = lightweight liveness probe. Used by the Docker HEALTHCHECK
// in deploy/Dockerfile.server. We deliberately do NOT hit the DB here — a
// transient DB hiccup should not cause Docker to mark the container
// unhealthy and (depending on swarm/compose setup) restart it. This endpoint
// answering at all means the Node event loop is alive.
app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'Monday Aniston API is running.',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// /api/health/deep = readiness/diagnostics probe. Verifies the DB pool can
// answer SELECT 1 within a short timeout. Use this from external monitoring
// (uptime checks, alerting). Returns 503 on failure so Prometheus/Pingdom etc
// can page on it without false positives from network blips.
app.get('/api/health/deep', async (_req, res) => {
  const startedAt = Date.now();
  try {
    await sequelize.query('SELECT 1', { plain: true });
    res.json({
      success: true,
      db: 'ok',
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Health] Deep check failed:', err && err.message);
    res.status(503).json({
      success: false,
      db: 'error',
      message: 'Database unavailable',
      latencyMs: Date.now() - startedAt,
    });
  }
});

// ─── Rate limiting ──────────────────────────────────────────
//
// Shared 429 response shape so the frontend can branch on `code === 'rate_limited'`
// and read `retryAfter` (seconds) without parsing free-text. `standardHeaders`
// also surfaces RateLimit-* / Retry-After response headers per RFC 6585 / draft.
function rateLimitHandler(label) {
  return (req, res, _next, options) => {
    const retryAfterSec = Math.ceil(options.windowMs / 1000);
    res.set('Retry-After', String(retryAfterSec));
    res.status(options.statusCode || 429).json({
      success: false,
      code: 'rate_limited',
      bucket: label,
      message: 'Too many requests. Please wait before retrying.',
      retryAfter: retryAfterSec,
    });
  };
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 login attempts per 15 min per IP (increased for shared office networks)
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('auth'),
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // 50 uploads per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('upload'),
});

const searchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 searches per minute
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('search'),
});

// General API rate limiter — broad safety net for /api/*. Combined with the
// trust-proxy fix above this is now per real client IP, so one stuck browser
// tab can only throttle ITSELF (and others on the same NAT, mitigated below
// by route-specific limiters with their own budgets).
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 300, // gentle global ceiling per real client IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('general'),
});

// Heavy board/task endpoints. The BoardPage in production has hit these in a
// retry loop before; this caps any one client well under the global budget so
// other clients on the same office NAT keep working even if one tab misbehaves.
const boardReadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 90, // ~1.5/sec sustained per real client IP for /boards/:id and /tasks reads
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('board_read'),
});

// External/HRMS API rate limiter (100 requests per minute per IP)
const externalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('external'),
});

// ─── API routes ──────────────────────────────────────────────
app.use('/api', generalLimiter); // Apply to all API routes

// External HRMS API (must be before dependency routes which apply global authenticate)
app.use('/api/external', externalLimiter, externalRoutes);

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth', authRoutes);
// boardReadLimiter sits in front of the heavy read endpoints so one misbehaving
// client can't burn the global budget that other users on the same NAT share.
app.use('/api/boards', boardReadLimiter, boardRoutes);
app.use('/api/tasks', boardReadLimiter, taskRoutes);
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
// /api/director-plan retired — return 410 Gone for any direct hits.
app.use('/api/director-plan', (_req, res) => res.status(410).json({ success: false, message: 'Director Plan module has been removed.' }));
app.use('/api/archive', archiveRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/integrations', integrationConfigRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/transcription', transcriptionRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/outbound-webhooks', outboundWebhookRoutes);
app.use('/api/recurring-tasks', recurringTaskRoutes);
app.use('/api/board-orders', boardOrderRoutes);
app.use('/api/system-settings', systemSettingsRoutes);

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

// ─── Boot-time route registration check ──────────────────────
// Recurring source of confusion: a running Node process serving requests on
// port 5000 keeps reporting "Route not found." for newly-added routes
// because the process was started before the file existed and hasn't been
// restarted. Verify on boot that the board-order routes are actually in the
// router's stack and print a clear log line either way. If this line is
// MISSING from your backend boot output, you are running stale code.
try {
  const wsRouter = workspaceRoutes;
  const wsLayers = wsRouter?.stack || [];
  const has = (method, p) => wsLayers.some(l => l.route?.path === p && l.route?.methods?.[method]);
  const getOk = has('get', '/:id/board-order');
  const putOk = has('put', '/:id/board-order');
  if (getOk && putOk) {
    console.log('[Routes] GET  /api/workspaces/:id/board-order registered');
    console.log('[Routes] PUT  /api/workspaces/:id/board-order registered');
  } else {
    console.warn(`[Routes] MISSING board-order routes! get=${getOk} put=${putOk}. Check server/routes/workspaces.js and restart the backend.`);
  }
  // Workspace-order (Rearrange Workspaces) routes — same paranoia as above.
  // The literal `/order` path MUST be registered before `/:id` in the
  // router file or Express will route `GET /api/workspaces/order` into
  // getWorkspace with id="order" and the 404 path won't even fire.
  const wsoGet = has('get', '/order');
  const wsoPut = has('put', '/order');
  if (wsoGet && wsoPut) {
    console.log('[Routes] GET  /api/workspaces/order registered');
    console.log('[Routes] PUT  /api/workspaces/order registered');
  } else {
    console.warn(`[Routes] MISSING workspace-order routes! get=${wsoGet} put=${wsoPut}. Check server/routes/workspaces.js and restart the backend.`);
  }
  const boRouter = boardOrderRoutes;
  if (boRouter?.stack?.some(l => l.route?.path === '/mine' && l.route?.methods?.get)) {
    console.log('[Routes] GET  /api/board-orders/mine registered');
  }
} catch (e) {
  console.warn('[Routes] route registration check failed:', e.message);
}

// ─── 404 handler ─────────────────────────────────────────────
// In development, include the method and path in the response so a stale
// route registration is obvious from the network panel. In production, keep
// the response generic to avoid leaking the API surface to unauthenticated
// scanners.
app.use((req, res) => {
  const isDev = process.env.NODE_ENV !== 'production';
  // Always log the unmatched request — this is the single most useful
  // diagnostic when "Route not found" comes back.
  console.warn(`[Server] 404 ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    success: false,
    message: 'Route not found.',
    ...(isDev ? { method: req.method, path: req.originalUrl } : {}),
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

    // Extend notification type ENUM with deadline reminder types + priority_change
    // + governance/lifecycle types that were previously misusing 'task_updated'.
    // All values must also be present in models/Notification.js.
    for (const val of [
      'deadline_2day',
      'deadline_2hour',
      'priority_change',
      'access_requested',
      'access_approved',
      'access_rejected',
      'extension_requested',
      'extension_approved',
      'extension_rejected',
      'help_requested',
      'help_responded',
      'promotion',
      'board_member_added',
      'board_member_removed',
    ]) {
      try {
        await sequelize.query(`ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS '${val}';`);
      } catch (e) { /* already exists or type not created yet */ }
    }
    console.log('[Server] Notification type ENUM extended (reminders + priority_change + governance).');

    // ── Auto-migration: push_subscriptions table ──────────────
    // DB-backed VAPID push subscriptions. Replaces the previous in-memory Map
    // in services/pushService.js so subscriptions survive restart and aren't
    // split across replicas. Endpoint is globally unique — same browser maps
    // to the same row regardless of which user signs in on it; the row gets
    // re-linked to the new userId on subscribe, and isActive flips on logout.
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId"        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint        TEXT NOT NULL,
        p256dh          VARCHAR(255) NOT NULL,
        auth            VARCHAR(255) NOT NULL,
        "userAgent"     VARCHAR(500),
        "deviceId"      VARCHAR(64),
        "isActive"      BOOLEAN NOT NULL DEFAULT TRUE,
        "lastSeenAt"    TIMESTAMP WITH TIME ZONE,
        "deactivatedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      // Endpoints can exceed VARCHAR(255) on some browsers (FCM URLs include
      // long opaque tokens), hence TEXT. Unique index uses md5 hash to stay
      // within Postgres btree's 8KB key limit.
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_uniq
        ON push_subscriptions (md5(endpoint))`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
        ON push_subscriptions ("userId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS push_subscriptions_user_active_idx
        ON push_subscriptions ("userId", "isActive")`);
      console.log('[Server] push_subscriptions table ensured.');
    } catch (e) {
      console.warn('[Server] push_subscriptions migration warning:', e.message?.slice(0, 200));
    }

    // ── Auto-migration: notifications performance indexes ─────
    // Speeds up the bell list (ordered by createdAt DESC) and the unread-count
    // query (the most-hit endpoint per page load).
    try {
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_created
        ON notifications ("userId", "createdAt" DESC)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
        ON notifications ("userId") WHERE "isRead" = false`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_notifications_entity
        ON notifications ("entityType", "entityId")`);
    } catch (e) {
      console.warn('[Server] notifications index migration warning:', e.message?.slice(0, 200));
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

    // ── Auto-migration: user_board_orders table ───────────────────
    // Per-user board ordering inside workspaces (sidebar Rearrange feature).
    // Idempotent — safe to run on every boot.
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS user_board_orders (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId"      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "workspaceId" UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        "boardId"     UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        "position"    INTEGER NOT NULL DEFAULT 0,
        "createdAt"   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt"   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS user_board_orders_uniq
        ON user_board_orders ("userId", "workspaceId", "boardId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS user_board_orders_lookup
        ON user_board_orders ("userId", "workspaceId", "position")`);
      console.log('[Server] user_board_orders table ensured.');
    } catch (e) {
      console.warn('[Server] user_board_orders migration warning:', e.message?.slice(0, 120));
    }

    // ── Auto-migration: user_workspace_orders table ──────────────
    // Per-user workspace ordering for the sidebar (Rearrange Workspaces).
    // Idempotent — safe to run on every boot. ON DELETE CASCADE is critical
    // here so stale rows for archived/deleted workspaces don't accumulate.
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS user_workspace_orders (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId"      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "workspaceId" UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        "position"    INTEGER NOT NULL DEFAULT 0,
        "createdAt"   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt"   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS user_workspace_orders_uniq
        ON user_workspace_orders ("userId", "workspaceId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS user_workspace_orders_lookup
        ON user_workspace_orders ("userId", "position")`);
      console.log('[Server] user_workspace_orders table ensured.');
    } catch (e) {
      console.warn('[Server] user_workspace_orders migration warning:', e.message?.slice(0, 120));
    }

    // ── Auto-migration: task_approval_flows table + stage column ──
    // Self-installing DDL — mirrors server/scripts/create-task-approval-flow.js
    // and server/scripts/migrate-task-approval-flow-stage.js so the schema is
    // guaranteed in production without anyone running a manual script.
    //
    // Why this is required (not just relying on sequelize.sync):
    //   sync({ alter: false }) creates missing tables, but the FK on userId
    //   with ON DELETE SET NULL is exactly the case CLAUDE.md flags as
    //   unreliable for Sequelize's generated SQL. When sync errors on this
    //   table the surrounding try/catch silently continues, the table is
    //   never created, and every POST /api/task-extras/:id/submit-approval
    //   blows up with `42P01 relation "task_approval_flows" does not exist`,
    //   surfaced to the UI as "Server database schema is out of date" by
    //   approvalController.buildErrorResponse.
    //
    // Idempotent: every statement uses IF NOT EXISTS / IS NULL guards, so
    // re-running on every boot is a no-op once the schema is up to date.
    // Non-destructive: nothing here drops, truncates, or rewrites data.
    try {
      // gen_random_uuid() needs pgcrypto. Cheap to assert per boot.
      await sequelize.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

      // Canonical DDL (kept byte-for-byte identical to create-task-approval-flow.js
      // so the manual script and the boot-time path produce the same shape).
      await sequelize.query(`CREATE TABLE IF NOT EXISTS task_approval_flows (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "taskId"        UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "userId"        UUID REFERENCES users(id) ON DELETE SET NULL,
        "userName"      VARCHAR(255),
        role            VARCHAR(50),
        level           INTEGER NOT NULL,
        stage           INTEGER,
        status          VARCHAR(30) NOT NULL DEFAULT 'pending',
        comment         TEXT,
        "attachmentUrl" TEXT,
        "actionAt"      TIMESTAMP WITH TIME ZONE,
        "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);

      // Defensive ADD COLUMN — covers the case where an older deploy created
      // the table before `stage` existed. Backfill stage = level so existing
      // in-flight chains route through findCurrentStageRows correctly.
      await sequelize.query(`ALTER TABLE task_approval_flows ADD COLUMN IF NOT EXISTS stage INTEGER`);
      await sequelize.query(`UPDATE task_approval_flows SET stage = level WHERE stage IS NULL`);

      // All four indexes from the model definition. The unique (taskId, level)
      // index is load-bearing — submitForApproval relies on it to prevent
      // duplicate level rows under concurrent submissions.
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS task_approval_flows_task_level_unique
        ON task_approval_flows ("taskId", level)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS task_approval_flows_task_status_idx
        ON task_approval_flows ("taskId", status)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS task_approval_flows_user_status_idx
        ON task_approval_flows ("userId", status)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS task_approval_flows_task_stage_status_idx
        ON task_approval_flows ("taskId", stage, status)`);

      // Verification — log the column set so an operator can confirm the
      // schema is in shape after a deploy without a separate query.
      const [verifyCols] = await sequelize.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'task_approval_flows'
            AND column_name IN ('stage','level','status','taskId','userId')
          ORDER BY column_name`
      );
      const present = verifyCols.map((r) => r.column_name).join(',') || '(none)';
      console.log(`[Server] task_approval_flows table ensured. Verified columns: ${present}.`);
    } catch (e) {
      console.warn('[Server] task_approval_flows migration warning:', e.message?.slice(0, 200));
    }

    // ── Auto-migration: permission_grants schema upgrades (008) ──
    // Adds action-based permission columns required by permissionEngine.js
    try {
      const [pgTables] = await sequelize.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'permission_grants'`
      );
      if (pgTables.length > 0) {
        await sequelize.query(`ALTER TABLE permission_grants ALTER COLUMN "permissionLevel" DROP NOT NULL`);
        await sequelize.query(`ALTER TABLE permission_grants ALTER COLUMN "permissionLevel" SET DEFAULT NULL`);
        await sequelize.query(`ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS action VARCHAR(50)`);
        await sequelize.query(`ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP WITH TIME ZONE`);
        await sequelize.query(`ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS "revokedBy" UUID REFERENCES users(id)`);
        await sequelize.query(`ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS reason TEXT`);
        await sequelize.query(`ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS scope VARCHAR(20) DEFAULT 'global'`);
        await sequelize.query(`ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS "isOverride" BOOLEAN DEFAULT true`);
        await sequelize.query(`ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS notes TEXT`);
        // 'effect' is required by permissionEngine.js (deny > grant > role default).
        // Without it any PermissionGrant.findAll() crashes with `column "effect"
        // does not exist` because the Sequelize model SELECTs it. Backfill any
        // pre-existing row to 'grant' so the NOT NULL constraint is satisfied
        // before we tighten it.
        await sequelize.query(`ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS effect VARCHAR(10) DEFAULT 'grant'`);
        await sequelize.query(`UPDATE permission_grants SET effect = 'grant' WHERE effect IS NULL`);
        await sequelize.query(`ALTER TABLE permission_grants ALTER COLUMN effect SET NOT NULL`);
        await sequelize.query(`ALTER TABLE permission_grants ALTER COLUMN effect SET DEFAULT 'grant'`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_permission_grants_action ON permission_grants(action)`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_permission_grants_resource_action ON permission_grants("resourceType", action)`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_permission_grants_user_resource_action ON permission_grants("userId", "resourceType", action)`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_permission_grants_effect ON permission_grants(effect)`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_permission_grants_user_resource_action_effect ON permission_grants("userId", "resourceType", action, effect)`);
        console.log('[Server] permission_grants schema upgrades ensured.');
      }
    } catch (e) {
      console.warn('[Server] permission_grants migration warning:', e.message?.slice(0, 100));
    }

    // ── Auto-migration: labels and task_labels tables ──
    // These are required by the Label include in task queries.
    // Without them, every task fetch crashes with "relation does not exist".
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS labels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        color VARCHAR(50) DEFAULT '#6366f1',
        "boardId" UUID REFERENCES boards(id) ON DELETE CASCADE,
        "createdBy" UUID REFERENCES users(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE TABLE IF NOT EXISTS task_labels (
        "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "labelId" UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        PRIMARY KEY ("taskId", "labelId")
      )`);
      console.log('[Server] labels and task_labels tables ensured.');
    } catch (e) {
      console.warn('[Server] labels/task_labels migration warning:', e.message?.slice(0, 100));
    }

    // ── Auto-migration: file_attachments table ──
    // Required by the file upload/fetch endpoints.
    // Without it, every file operation crashes with "relation does not exist".
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS file_attachments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        filename VARCHAR(500) NOT NULL,
        "originalName" VARCHAR(500) NOT NULL,
        mimetype VARCHAR(100) NOT NULL,
        size INTEGER NOT NULL,
        url VARCHAR(1000) NOT NULL,
        provider VARCHAR(50) NOT NULL DEFAULT 'local',
        category VARCHAR(50) NOT NULL DEFAULT 'task_attachment',
        "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "uploadedBy" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      console.log('[Server] file_attachments table ensured.');
    } catch (e) {
      console.warn('[Server] file_attachments migration warning:', e.message?.slice(0, 100));
    }

    // ── Auto-migration: add provider & category columns to file_attachments ──
    // Required by the storage-provider abstraction (007_add_file_attachment_columns.sql).
    // Existing tables created before this migration will be missing these columns.
    try {
      await sequelize.query(`ALTER TABLE file_attachments ADD COLUMN IF NOT EXISTS provider VARCHAR(50) NOT NULL DEFAULT 'local'`);
      await sequelize.query(`ALTER TABLE file_attachments ADD COLUMN IF NOT EXISTS category VARCHAR(50) NOT NULL DEFAULT 'task_attachment'`);
      console.log('[Server] file_attachments provider/category columns ensured.');
    } catch (e) {
      console.warn('[Server] file_attachments column migration warning:', e.message?.slice(0, 100));
    }

    // ── Auto-migration: webhooks + webhook_deliveries ─────────
    // Outbound webhook subscriptions registered against an API key. Receivers
    // get task lifecycle events POSTed to their URL with HMAC-SHA256 sigs.
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS webhooks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "apiKeyId" UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        name VARCHAR(150) NOT NULL,
        url VARCHAR(1000) NOT NULL,
        secret VARCHAR(128) NOT NULL,
        events JSONB NOT NULL DEFAULT '["task.created","task.updated","task.deleted"]'::jsonb,
        "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
        "lastDeliveredAt" TIMESTAMP WITH TIME ZONE,
        "lastErrorAt" TIMESTAMP WITH TIME ZONE,
        "lastErrorMessage" TEXT,
        "createdBy" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS webhooks_api_key_idx ON webhooks("apiKeyId")`);

      await sequelize.query(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "webhookId" UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event VARCHAR(50) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        "responseStatus" INTEGER,
        "responseBody" TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        "lastAttemptAt" TIMESTAMP WITH TIME ZONE,
        "nextRetryAt" TIMESTAMP WITH TIME ZONE,
        "errorMessage" TEXT,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS webhook_deliveries_status_retry_idx
        ON webhook_deliveries(status, "nextRetryAt")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_created_idx
        ON webhook_deliveries("webhookId", "createdAt")`);
      console.log('[Server] webhooks + webhook_deliveries tables ensured.');
    } catch (e) {
      console.warn('[Server] webhooks migration warning:', e.message?.slice(0, 200));
    }

    // ── Auto-migration: transcription_providers + transcript_segments ──
    // Creates the tables required for the Deepgram meeting-mode integration.
    // IF NOT EXISTS keeps this idempotent on every boot.
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS transcription_providers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        "providerType" VARCHAR(30) NOT NULL,
        "apiKey" TEXT NOT NULL,
        model VARCHAR(100) DEFAULT '',
        language VARCHAR(10) DEFAULT 'en-US',
        "baseUrl" VARCHAR(500) DEFAULT '',
        "diarizationEnabled" BOOLEAN DEFAULT true,
        "isActive" BOOLEAN DEFAULT true,
        "isDefault" BOOLEAN DEFAULT false,
        "lastTestedAt" TIMESTAMP WITH TIME ZONE,
        "configuredBy" UUID REFERENCES users(id) ON DELETE SET NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_transcription_providers_default ON transcription_providers("isDefault", "isActive")`);
      console.log('[Server] transcription_providers table ensured.');
    } catch (e) {
      console.warn('[Server] transcription_providers migration warning:', e.message?.slice(0, 100));
    }

    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS transcript_segments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "noteId" UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        "speakerLabel" VARCHAR(50) NOT NULL DEFAULT 'Speaker 0',
        "startMs" INTEGER NOT NULL DEFAULT 0,
        "endMs" INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL DEFAULT '',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_transcript_segments_note_id ON transcript_segments("noteId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_transcript_segments_note_start ON transcript_segments("noteId", "startMs")`);
      console.log('[Server] transcript_segments table ensured.');
    } catch (e) {
      console.warn('[Server] transcript_segments migration warning:', e.message?.slice(0, 100));
    }

    // ── Auto-migration: Task calendar-sync columns (migration 010) ──
    // Mirrors server/migrations/010_add_task_calendar_sync_fields.sql.
    // Originally applied via server/migrations/run_010.js, but deploy.yml
    // never invokes that script — so prod DBs deployed before commit
    // 0a90125 are missing these columns, and `Task.findAll` (which selects
    // all model-declared columns by default) crashes with
    // `column tasks."syncStatus" does not exist`. That single failure takes
    // down GET /api/boards/:id (eager-loads tasks) and GET /api/tasks at
    // the same time — i.e. the production board page exactly. Idempotent:
    // each ADD COLUMN guarded with its own try so a single failure does
    // not abort the rest of the schema fixes.
    for (const stmt of [
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "teamsCalendarUserId" VARCHAR(255)`,
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "syncStatus" VARCHAR(20) NOT NULL DEFAULT 'not_synced'`,
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "lastSyncedAt" TIMESTAMP WITH TIME ZONE`,
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "syncError" TEXT`,
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "syncAttempts" INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_sync_status_retry ON tasks ("syncStatus") WHERE "syncStatus" IN ('failed', 'pending')`,
    ]) {
      try {
        await sequelize.query(stmt);
      } catch (e) {
        console.warn('[Server] tasks calendar-sync migration warning:', e.message?.slice(0, 200));
      }
    }
    console.log('[Server] tasks calendar-sync columns ensured.');

    // ── Auto-migration: Daily Work / Recurring Task workflow schema ──
    // Mirrors server/scripts/create-recurring-task-templates.js +
    // server/scripts/add-recurring-fields-to-tasks.js so the schema is
    // self-installing on every boot. Without this, existing prod DBs that
    // pre-date this feature stay stuck on the old schema (sequelize.sync
    // with alter:false creates missing tables but NEVER adds missing
    // columns to existing tables) — and every Task.findAll on the new
    // columns crashes with `column tasks.recurringTemplateId does not exist`,
    // taking down /api/tasks, /api/dashboard/stats,
    // /api/task-extras/workflow-items, /api/task-extras/my-feedback, and
    // /api/recurring-tasks. All statements are idempotent (IF NOT EXISTS).
    // Runs BEFORE sequelize.sync so the FK target table is in place when
    // sync evaluates Task model FKs.
    try {
      // pgcrypto provides gen_random_uuid() used by table DDL below.
      await sequelize.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

      // 1. recurring_task_templates table
      await sequelize.query(`CREATE TABLE IF NOT EXISTS recurring_task_templates (
        id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title                   VARCHAR(300) NOT NULL,
        description             TEXT,
        "boardId"               UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        "groupId"               VARCHAR(100) NOT NULL DEFAULT 'new',
        "assigneeId"            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "createdBy"             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        priority                VARCHAR(20) NOT NULL DEFAULT 'medium',
        frequency               VARCHAR(20) NOT NULL DEFAULT 'daily',
        weekdays                JSONB NOT NULL DEFAULT '[]'::jsonb,
        "dayOfMonth"            INTEGER,
        "startDate"             DATE NOT NULL,
        "endDate"               DATE,
        "dueTime"               TIME NOT NULL DEFAULT '18:00:00',
        timezone                VARCHAR(64) NOT NULL DEFAULT 'UTC',
        "escalateIfMissed"      BOOLEAN NOT NULL DEFAULT FALSE,
        "escalationTargets"     JSONB NOT NULL DEFAULT '["assignee","manager"]'::jsonb,
        "isActive"              BOOLEAN NOT NULL DEFAULT TRUE,
        "lastGeneratedDate"     DATE,
        "nextRunAt"             TIMESTAMP WITH TIME ZONE,
        "archivedAt"            TIMESTAMP WITH TIME ZONE,
        "createdAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      // Defensive constraints (idempotent via NOT EXISTS via DO block — old DBs
      // may already have the table from a prior partial install).
      await sequelize.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_task_templates_frequency_check') THEN
          ALTER TABLE recurring_task_templates ADD CONSTRAINT recurring_task_templates_frequency_check
            CHECK (frequency IN ('daily','weekdays','weekly','monthly','custom'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_task_templates_priority_check') THEN
          ALTER TABLE recurring_task_templates ADD CONSTRAINT recurring_task_templates_priority_check
            CHECK (priority IN ('low','medium','high','critical'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_task_templates_end_after_start_check') THEN
          ALTER TABLE recurring_task_templates ADD CONSTRAINT recurring_task_templates_end_after_start_check
            CHECK ("endDate" IS NULL OR "endDate" >= "startDate");
        END IF;
      END $$`);
      // Multi-day monthly support — adds an array column alongside the legacy
      // single `dayOfMonth` integer. Old templates keep working because the
      // service-layer reader prefers `daysOfMonth` when non-empty and falls
      // back to `[dayOfMonth]`. Backfill below normalises existing rows so the
      // array becomes the source of truth going forward; the legacy column is
      // still written by the controller (= daysOfMonth[0]) for any older read
      // path we haven't migrated.
      await sequelize.query(`ALTER TABLE recurring_task_templates
        ADD COLUMN IF NOT EXISTS "daysOfMonth" JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await sequelize.query(`UPDATE recurring_task_templates
        SET "daysOfMonth" = jsonb_build_array("dayOfMonth")
        WHERE "dayOfMonth" IS NOT NULL
          AND ("daysOfMonth" IS NULL OR "daysOfMonth" = '[]'::jsonb)`);

      await sequelize.query(`CREATE INDEX IF NOT EXISTS recurring_task_templates_next_run_idx
        ON recurring_task_templates ("nextRunAt") WHERE "isActive" = TRUE AND "archivedAt" IS NULL`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS recurring_task_templates_assignee_idx
        ON recurring_task_templates ("assigneeId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS recurring_task_templates_board_idx
        ON recurring_task_templates ("boardId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS recurring_task_templates_active_idx
        ON recurring_task_templates ("isActive", "archivedAt")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS recurring_task_templates_created_by_idx
        ON recurring_task_templates ("createdBy")`);
      console.log('[Server] recurring_task_templates table ensured.');

      // 2. New columns on tasks for recurring-instance bookkeeping. ON DELETE
      //    SET NULL keeps generated task history intact even if the template
      //    is hard-deleted (we soft-archive by default).
      await sequelize.query(`ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS "recurringTemplateId" UUID
        REFERENCES recurring_task_templates(id) ON DELETE SET NULL`);
      await sequelize.query(`ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS "occurrenceDate" DATE`);
      await sequelize.query(`ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS "isRecurringInstance" BOOLEAN NOT NULL DEFAULT FALSE`);
      await sequelize.query(`ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP WITH TIME ZONE`);
      await sequelize.query(`ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS "missedEscalationSent" BOOLEAN NOT NULL DEFAULT FALSE`);
      await sequelize.query(`ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS "missedEscalationSentAt" TIMESTAMP WITH TIME ZONE`);

      // Read-side index for missed-escalation job.
      await sequelize.query(`CREATE INDEX IF NOT EXISTS tasks_recurring_instance_idx
        ON tasks ("recurringTemplateId", "occurrenceDate")
        WHERE "isRecurringInstance" = TRUE`);
      // Duplicate-protection guarantee — partial unique index, only kicks in
      // for recurring instances. Non-recurring tasks unaffected.
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS tasks_recurring_template_occurrence_unique
        ON tasks ("recurringTemplateId", "occurrenceDate")
        WHERE "recurringTemplateId" IS NOT NULL AND "occurrenceDate" IS NOT NULL`);

      // Idempotent backfill — give legacy done-tasks a completedAt so
      // reporting queries that COALESCE(completedAt, updatedAt) work day one.
      await sequelize.query(`UPDATE tasks
        SET "completedAt" = "updatedAt"
        WHERE status = 'done' AND "completedAt" IS NULL`);
      console.log('[Server] tasks recurring/completedAt columns ensured.');

      // 3. notifications.type ENUM extensions used by the recurring jobs.
      //    Skip silently if the type doesn't exist yet (very fresh install).
      const [notifTypeRows] = await sequelize.query(
        `SELECT 1 FROM pg_type WHERE typname = 'enum_notifications_type'`
      );
      if (notifTypeRows.length > 0) {
        for (const v of ['recurring_generated', 'recurring_missed']) {
          try {
            await sequelize.query(`ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS '${v}'`);
          } catch (_) { /* already exists */ }
        }
        console.log('[Server] notifications.type ENUM extended for recurring events.');
      }
    } catch (e) {
      console.warn('[Server] Recurring-task schema migration warning:', e.message?.slice(0, 200));
    }

    // ── Auto-migration: Dependency Request system (migration 012) ──
    // Mirrors server/migrations/012_create_dependency_requests.sql so the
    // table, indexes, and CHECK constraints are self-installing on every
    // boot. Without this block the new dependency endpoints crash with
    // `relation "dependency_requests" does not exist`. All statements are
    // idempotent (IF NOT EXISTS / DO blocks).
    for (const stmt of [
      `CREATE TABLE IF NOT EXISTS dependency_requests (
        id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "parentTaskId"           UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title                    VARCHAR(300) NOT NULL,
        "blockingReason"         TEXT,
        "requestedByUserId"      UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
        "assignedToUserId"       UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
        "originalAssignerUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
        "boardId"                UUID REFERENCES boards(id) ON DELETE CASCADE,
        "workspaceId"            UUID REFERENCES workspaces(id) ON DELETE SET NULL,
        status                   VARCHAR(20) NOT NULL DEFAULT 'pending',
        priority                 VARCHAR(20) NOT NULL DEFAULT 'medium',
        "dueDate"                DATE,
        "acceptedAt"             TIMESTAMP WITH TIME ZONE,
        "startedAt"              TIMESTAMP WITH TIME ZONE,
        "completedAt"            TIMESTAMP WITH TIME ZONE,
        "rejectedAt"             TIMESTAMP WITH TIME ZONE,
        "cancelledAt"            TIMESTAMP WITH TIME ZONE,
        "rejectionReason"        TEXT,
        "cancellationReason"     TEXT,
        "completedByUserId"      UUID REFERENCES users(id) ON DELETE SET NULL,
        "archivedAt"             TIMESTAMP WITH TIME ZONE,
        "archivedBy"             UUID REFERENCES users(id) ON DELETE SET NULL,
        "createdAt"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dep_req_status_check') THEN
          ALTER TABLE dependency_requests ADD CONSTRAINT dep_req_status_check
            CHECK (status IN ('pending','accepted','working_on_it','done','rejected','cancelled'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dep_req_priority_check') THEN
          ALTER TABLE dependency_requests ADD CONSTRAINT dep_req_priority_check
            CHECK (priority IN ('low','medium','high','critical'));
        END IF;
      END $$`,
      `CREATE INDEX IF NOT EXISTS dep_req_parent_idx           ON dependency_requests ("parentTaskId")`,
      `CREATE INDEX IF NOT EXISTS dep_req_assigned_status_idx  ON dependency_requests ("assignedToUserId", status)`,
      `CREATE INDEX IF NOT EXISTS dep_req_requested_status_idx ON dependency_requests ("requestedByUserId", status)`,
      `CREATE INDEX IF NOT EXISTS dep_req_board_idx            ON dependency_requests ("boardId")`,
      `CREATE INDEX IF NOT EXISTS dep_req_status_idx           ON dependency_requests (status)`,
      `CREATE INDEX IF NOT EXISTS dep_req_due_date_idx         ON dependency_requests ("dueDate")`,
      `CREATE INDEX IF NOT EXISTS dep_req_created_at_idx       ON dependency_requests ("createdAt")`,
      `CREATE INDEX IF NOT EXISTS dep_req_active_parent_idx
        ON dependency_requests ("parentTaskId")
        WHERE status IN ('pending','accepted','working_on_it') AND "archivedAt" IS NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS dep_req_active_unique_idx
        ON dependency_requests ("parentTaskId", "assignedToUserId", lower(btrim(title)))
        WHERE status IN ('pending','accepted','working_on_it') AND "archivedAt" IS NULL`,
    ]) {
      try {
        await sequelize.query(stmt);
      } catch (e) {
        console.warn('[Server] dependency_requests migration warning:', e.message?.slice(0, 200));
      }
    }
    console.log('[Server] dependency_requests table ensured.');

    // ── Auto-migration: extend notifications.type enum for dependency events ──
    // Mirrors the recurring-task pattern: probe for the enum first (fresh
    // installs may not have it yet), then ALTER TYPE per value with
    // IF NOT EXISTS so re-runs are no-ops.
    try {
      const [depNotifEnumRows] = await sequelize.query(
        `SELECT 1 FROM pg_type WHERE typname = 'enum_notifications_type'`
      );
      if (depNotifEnumRows.length > 0) {
        for (const v of [
          'dependency_requested',
          'dependency_accepted',
          'dependency_started',
          'dependency_done',
          'dependency_rejected',
          'dependency_cancelled',
        ]) {
          try {
            await sequelize.query(`ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS '${v}'`);
          } catch (_) { /* already exists */ }
        }
        console.log('[Server] notifications.type ENUM extended for dependency events.');
      }
    } catch (e) {
      console.warn('[Server] notifications.type dependency-enum migration warning:', e.message?.slice(0, 200));
    }

    // ── Auto-migration: Subtask inline-table columns ──
    // Inline subtasks render in the board grid with the same column set as
    // main tasks (priority, progress, due date, description). The Subtask
    // model declares these but `sequelize.sync({ alter: false })` only
    // creates missing tables — it never adds missing columns to an existing
    // `subtasks` table. Without this block the inline subtask UI would
    // crash on existing prod DBs with `column "priority" does not exist`.
    // All statements are idempotent.
    for (const stmt of [
      `ALTER TABLE subtasks ADD COLUMN IF NOT EXISTS "priority" VARCHAR(20)`,
      `ALTER TABLE subtasks ADD COLUMN IF NOT EXISTS "progress" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE subtasks ADD COLUMN IF NOT EXISTS "dueDate" TIMESTAMP WITH TIME ZONE`,
      `ALTER TABLE subtasks ADD COLUMN IF NOT EXISTS "description" TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_subtasks_due_date ON subtasks ("dueDate")`,
      // Range guard for progress; matches the model validator. Wrapped in DO
      // so re-runs don't trip "constraint already exists".
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subtasks_progress_range_check') THEN
          ALTER TABLE subtasks ADD CONSTRAINT subtasks_progress_range_check
            CHECK ("progress" >= 0 AND "progress" <= 100);
        END IF;
      END $$`,
      // Priority must match the same canonical set used on tasks.
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subtasks_priority_check') THEN
          ALTER TABLE subtasks ADD CONSTRAINT subtasks_priority_check
            CHECK ("priority" IS NULL OR "priority" IN ('low','medium','high','critical'));
        END IF;
      END $$`,
    ]) {
      try {
        await sequelize.query(stmt);
      } catch (e) {
        console.warn('[Server] subtasks inline-columns migration warning:', e.message?.slice(0, 200));
      }
    }
    console.log('[Server] subtasks inline-table columns ensured.');

    // ── Auto-migration: system_settings table ────────────────────
    // Generic key/value store for platform-wide settings (e.g. inactivity
    // auto-logout duration). Created here explicitly so the table exists
    // independent of sequelize.sync timing, and so the row for inactivity
    // timeout is seeded with the historical 5-minute default — preserving
    // existing behavior until a Super Admin changes it.
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS system_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(100) NOT NULL UNIQUE,
        value JSONB NOT NULL,
        description TEXT,
        "updatedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`
        INSERT INTO system_settings (key, value, description)
        VALUES ('inactivity_timeout_minutes', '{"minutes": 5}'::jsonb, 'Auto-logout duration after user inactivity (minutes).')
        ON CONFLICT (key) DO NOTHING
      `);
      console.log('[Server] system_settings table ensured.');
    } catch (e) {
      console.warn('[Server] system_settings migration warning:', e.message?.slice(0, 200));
    }

    // Sync models — create missing tables only, skip ALTER (Sequelize ALTER has bugs with REFERENCES)
    try {
      await sequelize.sync({ alter: false });
      console.log('[Server] Database models synced.');
    } catch (syncErr) {
      console.warn('[Server] DB sync warning (non-fatal):', syncErr.message?.slice(0, 100));
      console.log('[Server] Continuing with existing schema...');
    }

    // ── Auto-migration: Add autoAdded column to BoardMembers ──
    // Tracks whether a membership was auto-added (via task assignment) or
    // explicitly added (via Board Settings). Only auto-added rows are cleaned
    // up when the user's last task on the board is unassigned.
    try {
      const [bmTables] = await sequelize.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'BoardMembers'`
      );
      if (bmTables.length > 0) {
        // 1. Add column if missing
        await sequelize.query(`ALTER TABLE "BoardMembers" ADD COLUMN IF NOT EXISTS "autoAdded" BOOLEAN NOT NULL DEFAULT true`);
        console.log('[Server] BoardMembers.autoAdded column ensured.');

        // 2. Mark board creators as explicit members (autoAdded=false)
        await sequelize.query(`
          UPDATE "BoardMembers" bm SET "autoAdded" = false, "updatedAt" = NOW()
          FROM boards b WHERE bm."boardId" = b.id AND bm."userId" = b."createdBy" AND bm."autoAdded" = true
        `);

        // 3. Mark admin/manager/assistant_manager members as explicit
        await sequelize.query(`
          UPDATE "BoardMembers" bm SET "autoAdded" = false, "updatedAt" = NOW()
          FROM users u WHERE bm."userId" = u.id AND u.role IN ('admin', 'manager', 'assistant_manager') AND bm."autoAdded" = true
        `);

        // 4. Remove stale auto-added rows where member has no active tasks
        const [, cleanMeta] = await sequelize.query(`
          DELETE FROM "BoardMembers" bm
          WHERE bm."autoAdded" = true
            AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t."boardId" = bm."boardId" AND t."assignedTo" = bm."userId" AND (t."isArchived" = false OR t."isArchived" IS NULL))
            AND NOT EXISTS (SELECT 1 FROM task_assignees ta JOIN tasks t ON t.id = ta."taskId" WHERE t."boardId" = bm."boardId" AND ta."userId" = bm."userId" AND (t."isArchived" = false OR t."isArchived" IS NULL))
            AND NOT EXISTS (SELECT 1 FROM task_owners to2 JOIN tasks t ON t.id = to2."taskId" WHERE t."boardId" = bm."boardId" AND to2."userId" = bm."userId" AND (t."isArchived" = false OR t."isArchived" IS NULL))
        `);
        const cleaned = cleanMeta?.rowCount ?? 0;
        if (cleaned > 0) console.log(`[Server] Cleaned ${cleaned} stale auto-added BoardMembers rows.`);
      }
    } catch (e) {
      console.warn('[Server] BoardMembers autoAdded migration warning:', e.message?.slice(0, 100));
    }

    // ── Data backfill: progress=100 for tasks already marked done ──
    // Idempotent — only touches rows that are out-of-sync with the new
    // "completed ⇒ progress 100" invariant enforced by the controller.
    try {
      const [, meta] = await sequelize.query(
        `UPDATE tasks SET progress = 100 WHERE status = 'done' AND (progress IS NULL OR progress < 100)`
      );
      const updated = meta?.rowCount ?? 0;
      if (updated > 0) console.log(`[Server] Backfilled progress=100 on ${updated} done tasks.`);
    } catch (e) {
      console.warn('[Server] Done-task progress backfill warning:', e.message?.slice(0, 100));
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

    // ── Auto-migration: Add archivedGroups column to boards table ──
    try {
      const [boardTables] = await sequelize.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'boards'`
      );
      if (boardTables.length > 0) {
        await sequelize.query(`ALTER TABLE boards ADD COLUMN IF NOT EXISTS "archivedGroups" JSONB NOT NULL DEFAULT '[]'`);
        console.log('[Server] boards.archivedGroups column ensured.');
      }
    } catch (e) {
      console.warn('[Server] boards.archivedGroups migration warning:', e.message?.slice(0, 100));
    }

    // ── Auto-migration: Add local_status_override column to users ──
    // Tracks whether an admin manually edited a user's isActive flag from
    // Admin Settings. The Microsoft sync skips users with this flag so that
    // manual deactivations are not reactivated on the next sync cycle.
    try {
      const [userTables] = await sequelize.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`
      );
      if (userTables.length > 0) {
        await sequelize.query(
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS local_status_override BOOLEAN NOT NULL DEFAULT FALSE`
        );
        console.log('[Server] users.local_status_override column ensured.');
      }
    } catch (e) {
      console.warn('[Server] users.local_status_override migration warning:', e.message?.slice(0, 100));
    }

    // ── Auto-migration: Add font_size_preference column to users ──
    // Mirrors server/migrations/013_add_user_font_size_preference.sql so a
    // fresh boot picks up the column without an out-of-band migration step.
    // Idempotent ADD COLUMN IF NOT EXISTS + DO $$ guard for the CHECK
    // constraint — safe to re-run.
    try {
      const [userTablesFs] = await sequelize.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`
      );
      if (userTablesFs.length > 0) {
        await sequelize.query(
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS font_size_preference VARCHAR(20) DEFAULT NULL`
        );
        await sequelize.query(`
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
        `);
        console.log('[Server] users.font_size_preference column ensured.');
      }
    } catch (e) {
      console.warn('[Server] users.font_size_preference migration warning:', e.message?.slice(0, 100));
    }

    // ── Auto-migration: Add tier column to users (migration 014) ──
    // Mirrors server/migrations/014_add_user_tier.sql. Self-installing so
    // production deploys (which only restart the container, never invoke
    // run_014.js) get the column, the CHECK constraint, the index, and the
    // legacy→tier backfill on every boot. Without this block sequelize.sync
    // ({ alter: false }) would fail to add the column to existing prod DBs
    // and every User.findAll() would crash with `column users.tier does not
    // exist`. Idempotent: ADD COLUMN IF NOT EXISTS + DO $$ guard for the
    // constraint + CREATE INDEX IF NOT EXISTS. The backfill is
    // re-derivation-safe (running it twice produces the same value).
    try {
      const [userTablesTier] = await sequelize.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`
      );
      if (userTablesTier.length > 0) {
        await sequelize.query(
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS tier INTEGER NOT NULL DEFAULT 4`
        );
        await sequelize.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'users_tier_check'
            ) THEN
              ALTER TABLE users
                ADD CONSTRAINT users_tier_check
                CHECK (tier BETWEEN 1 AND 4);
            END IF;
          END $$;
        `);
        // Backfill from legacy fields. Idempotent — re-running re-derives the
        // same value from (isSuperAdmin, role) so concurrent boots are safe.
        await sequelize.query(`
          UPDATE users SET tier = CASE
            WHEN "isSuperAdmin" = true        THEN 1
            WHEN role IN ('admin','manager')  THEN 2
            WHEN role = 'assistant_manager'   THEN 3
            ELSE                                   4
          END
        `);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_users_tier ON users(tier)`);
        console.log('[Server] users.tier column + CHECK + index ensured.');
      }
    } catch (e) {
      console.warn('[Server] users.tier migration warning:', e.message?.slice(0, 100));
    }

    // ── Auto-migration: refresh_tokens table (D-2 — token rotation/denylist).
    // Stores one row per issued refresh JWT keyed by its JTI claim. The
    // /api/auth/refresh endpoint consults this table on every refresh and
    // rotates the row (revoking the old, issuing a new). On password change
    // and logout we revoke rows for the affected user. See models/RefreshToken
    // and the refresh/logout/changePassword controllers for details.
    //
    // CASCADE on userId: when a user is hard-deleted, drop their tokens. This
    // never happens for our soft-delete (`isActive=false`) flow but is the
    // safer default for any future hard-delete tooling.
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS refresh_tokens (
          jti UUID PRIMARY KEY,
          "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          "issuedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
          "revokedAt" TIMESTAMP WITH TIME ZONE,
          "replacedByJti" UUID,
          "userAgent" VARCHAR(255),
          "ip" VARCHAR(45),
          "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens("userId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens("expiresAt")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_revoked_at ON refresh_tokens("revokedAt")`);
      console.log('[Server] refresh_tokens table + indexes ensured.');
    } catch (e) {
      console.warn('[Server] refresh_tokens migration warning:', e.message?.slice(0, 120));
    }

    // ── Auto-migration: Add receipt columns to task_assignees ──
    // Per-assignee delivery/seen tracking for the WhatsApp-style receipt UI.
    // assignerId records who triggered the assignment (used to scope visibility
    // of the receipt icon to the assigner only).
    try {
      const [taTables] = await sequelize.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'task_assignees'`
      );
      if (taTables.length > 0) {
        await sequelize.query(`ALTER TABLE task_assignees ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP WITH TIME ZONE`);
        await sequelize.query(`ALTER TABLE task_assignees ADD COLUMN IF NOT EXISTS "seenAt" TIMESTAMP WITH TIME ZONE`);
        await sequelize.query(`ALTER TABLE task_assignees ADD COLUMN IF NOT EXISTS "assignerId" UUID REFERENCES users(id) ON DELETE SET NULL`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_task_assignees_user_delivery ON task_assignees("userId", "deliveredAt")`);
        console.log('[Server] task_assignees receipt columns ensured.');
      }
    } catch (e) {
      console.warn('[Server] task_assignees receipt-column migration warning:', e.message?.slice(0, 100));
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
      'CREATE INDEX IF NOT EXISTS idx_file_attachments_task_id ON file_attachments("taskId")',
      'CREATE INDEX IF NOT EXISTS idx_file_attachments_uploaded_by ON file_attachments("uploadedBy")',
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

    // ── One-time data cleanup: Director Plan & Time Plan ──
    // Uses system_flags DB table as a run-once guard.
    // First deploy: cleans director_plans + time_blocks, marks flag as completed.
    // All future restarts: single SELECT check (~2ms), silent skip.
    try {
      const { runStartupCleanup } = require('./cleanup-plan-data');
      await runStartupCleanup(sequelize);
    } catch (cleanupErr) {
      console.warn('[Server] Plan data cleanup skipped:', cleanupErr.message?.slice(0, 100));
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

      // Director Plan deadline notification cron retired (module removed).

      // Start deadline reminder job (every 15 minutes)
      const { startDeadlineReminderJob } = require('./jobs/deadlineReminderJob');
      startDeadlineReminderJob();

      // Start priority escalation job (daily at midnight)
      const { startPriorityEscalationJob } = require('./jobs/priorityEscalationJob');
      startPriorityEscalationJob();

      // Start Microsoft calendar sync retry job (every 15 min)
      const { startCalendarSyncRetryJob } = require('./jobs/calendarSyncRetryJob');
      startCalendarSyncRetryJob();

      // ─── Daily Work / Recurring Work jobs (Phase B) ─────────────────────
      // Distinct from the legacy `recurringTaskJob` (Task.recurrence JSONB)
      // which still runs at :15. These two jobs drive the new
      // RecurringTaskTemplate + generated-instance design.
      const { startRecurringTemplateGenerationJob } = require('./jobs/recurringTemplateGenerationJob');
      startRecurringTemplateGenerationJob();

      const { startMissedRecurringTaskJob } = require('./jobs/missedRecurringTaskJob');
      startMissedRecurringTaskJob();

      // Outbound webhook retry job (every 5 min) — drains failed deliveries
      const { startWebhookRetryJob } = require('./jobs/webhookRetryJob');
      startWebhookRetryJob();

      // Weekly VACUUM ANALYZE on hot tables. Defends against the planner-stats
      // drift class of incident (May 2026 pg_toast_2619 corruption hit prod
      // because autovacuum thresholds were too lax for our churn rate). The
      // job is replica-safe via a Postgres advisory lock — see jobs/cronLock.js.
      const { startVacuumAnalyzeJob } = require('./jobs/vacuumAnalyzeJob');
      startVacuumAnalyzeJob();
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
