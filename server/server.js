const http = require('http');
const path = require('path');
require('dotenv').config();
// Multi-manager support: ManagerRelation model + routes added (nodemon restart trigger)

// Docker Desktop containers on Windows commonly have no outbound IPv6
// routing. Microsoft's DNS-based geo-load-balancing sometimes returns ONLY
// IPv6 A/AAAA records for endpoints like login.microsoftonline.com and
// graph.microsoft.com (varies per query / region / time), so even with
// dns.setDefaultResultOrder('ipv4first') the resolver hands back zero
// IPv4 addresses to reorder, and every connect() hits ENETUNREACH.
//
// The robust fix is to force dns.lookup to ask for IPv4 records only
// when the caller didn't pin a family explicitly. Every HTTP client
// (axios, fetch, https, node-fetch, ...) routes through dns.lookup, so
// this single patch covers all outbound calls. Docker internal services
// (e.g. the `postgres` hostname inside the compose network) are IPv4-
// only by default, so they're unaffected.
//
// Production (AWS) has working IPv6, so we leave the default behavior
// alone there. FORCE_IPV4_DNS=true can opt-in for prod debugging.
if (process.env.NODE_ENV !== 'production' || process.env.FORCE_IPV4_DNS === 'true') {
  try {
    const dns = require('dns');
    const originalLookup = dns.lookup;
    dns.lookup = function patchedLookup(hostname, optionsOrCb, callback) {
      let options = optionsOrCb;
      let cb = callback;
      if (typeof options === 'function') { cb = options; options = {}; }
      else if (typeof options === 'number') { options = { family: options }; }
      else if (options == null) { options = {}; }
      if (options.family === undefined || options.family === 0) {
        options = Object.assign({}, options, { family: 4 });
      }
      return originalLookup.call(dns, hostname, options, cb);
    };
    // Also disable Happy Eyeballs so any caller that DOES pass family:0
    // explicitly still gets sequential single-family behavior.
    try { require('net').setDefaultAutoSelectFamily(false); } catch (_) { /* Node <20 */ }
  } catch (_) { /* leave defaults */ }
}

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

// â”€â”€â”€ Route imports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
// Workflow Canvas (Phase W1) â€” visual node-graph automation. Coexists
// with the legacy automation engine on /api/automations; both routes
// + both engines stay live.
const workflowRoutes = require('./routes/workflows');
const formRoutes = require('./routes/forms');
const workspaceRoutes = require('./routes/workspaces');
const permissionRoutes = require('./routes/permissions');
const accessRequestRoutes = require('./routes/accessRequests');
const taskExtrasRoutes = require('./routes/taskExtras');
const announcementRoutes = require('./routes/announcements');
const labelRoutes = require('./routes/labels');
const statusTemplateRoutes = require('./routes/statusTemplates');
const taskReferenceRoutes = require('./routes/taskReferences');
const taskLinkRoutes = require('./routes/taskLinks');
const metricsRoutes = require('./routes/metrics');
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
const meetingStreamRoutes = require('./routes/meetingStream');
const desktopDownloadRoutes = require('./routes/desktopDownload');
// Tier-1 (Super Admin) database backup management. Every endpoint inside
// is gated by superAdminOnly â€” see routes/adminBackups.js.
const adminBackupsRoutes = require('./routes/adminBackups');

// â”€â”€â”€ App initialisation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const app = express();

// Trust private-network proxies in front of the app.
//
// Production topology has TWO proxies: host nginx (terminates TLS on :443)
// â†’ frontend container nginx (proxies /api/ to backend container). With the
// previous `trust proxy: 1`, Express only stripped one hop from the right of
// X-Forwarded-For, so req.ip resolved to the Docker bridge gateway (e.g.
// 172.19.0.1) for every request. That meant express-rate-limit bucketed
// EVERY user under the same key â€” one stuck browser tab DoS'd the whole
// product, and `combined`-format access logs only ever showed the bridge IP.
//
// Trusting the standard private-IP ranges (loopback / link-local / unique-
// local â€” see RFC 1918 + RFC 4193) walks XFF from right to left, skips every
// trusted proxy, and uses the first non-private IP as req.ip. That is the
// real public client IP regardless of how many internal hops are added.
//
// Local dev (no proxy) still works: with no XFF header set, req.ip falls
// back to the connection address (127.0.0.1).
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

const server = http.createServer(app);

// â”€â”€â”€ Socket.io initialisation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
initializeSocket(server);

// â”€â”€â”€ Meeting-mode audio streaming WebSocket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Proxies browser PCM audio to Deepgram and forwards speaker-labeled
// transcripts back. Claims only /api/meeting-stream/ws so it coexists
// with Socket.io (which handles /socket.io/*).
const { attachMeetingStream } = require('./services/meetingStreamService');
attachMeetingStream(server);

// â”€â”€â”€ Doc Editor Phase G â€” collab WebSocket (Hocuspocus + Y.js) â”€â”€â”€â”€â”€â”€â”€
// Claims only /api/docs-collab/ws so it coexists with Socket.io and
// /api/meeting-stream/ws â€” each upgrade handler ignores paths it
// doesn't own. attachDocCollab returns null and logs if hocuspocus/yjs
// aren't installed; boot continues either way.
const { attachDocCollab } = require('./services/docCollabService');
attachDocCollab(server);

// â”€â”€â”€ Global middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// D-8 â€” Content-Security-Policy.
//
// We deploy CSP in REPORT-ONLY mode first so the browser sends violation
// reports without blocking anything. After observing the wild for a few
// days (collecting any unexpected sources via the `report-uri` endpoint
// /api/csp-report and/or browser DevTools), flip
// CSP_ENFORCE=true to switch to enforcement.
//
// Directive choices (each annotated with WHY):
//   default-src 'self'
//     â€” minimum baseline; any directive not explicitly set falls back here.
//   script-src 'self' 'unsafe-inline' 'unsafe-eval'
//     â€” Vite injects inline bootstrap scripts in index.html and the dev
//       toolbar uses eval. 'unsafe-inline' weakens script-src on its own,
//       but combined with our XSS sanitisation + the new SVG check (D-5)
//       this is acceptable. Long-term we'd switch to nonces or hashes.
//   style-src 'self' 'unsafe-inline' https://fonts.googleapis.com
//     â€” Tailwind's JIT generates style attributes; component libraries
//       (lucide-react, framer-motion) sometimes inline transforms.
//   img-src 'self' data: blob: https:
//     â€” avatars stored on /uploads (self), uploaded image previews
//       (data:/blob:), and external avatars / OG images (https:).
//   font-src 'self' data: https://fonts.gstatic.com
//     â€” embedded data URIs for icon fonts, Google Fonts CDN.
//   connect-src 'self' ws: wss: https://login.microsoftonline.com
//     â€” Socket.io needs ws/wss; SSO redirects to login.microsoftonline.com.
//   frame-ancestors 'none'
//     â€” disallow being embedded in an iframe (clickjacking defence).
//   form-action 'self' https://login.microsoftonline.com
//     â€” restrict where forms can post. Microsoft login form posts to
//       login.microsoftonline.com during SSO.
//   object-src 'none'
//     â€” kill the legacy <object>/<embed>/applet attack surface.
//   base-uri 'self'
//     â€” prevent <base> tag injection from rerouting relative URLs.
//   worker-src 'self' blob:
//     â€” service worker (sw.js) + any blob workers.
//   manifest-src 'self'
//     â€” PWA manifest.
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
  connectSrc: ["'self'", 'ws:', 'wss:', 'https://login.microsoftonline.com'],
  frameAncestors: ["'none'"],
  formAction: ["'self'", 'https://login.microsoftonline.com'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  workerSrc: ["'self'", 'blob:'],
  manifestSrc: ["'self'"],
  // Legacy CSP1 reporting directive â€” broadly supported. Modern browsers
  // also honour the Reporting-Endpoints header + report-to directive but
  // report-uri is the lowest-common-denominator and works for everyone.
  reportUri: ['/api/csp-report'],
};
const cspEnforce = String(process.env.CSP_ENFORCE || '').toLowerCase() === 'true';

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    useDefaults: false,
    reportOnly: !cspEnforce,
    directives: cspDirectives,
  },
}));

// CSP violation report receiver. Browsers POST a JSON `csp-report` object
// here when something violates the policy. We log truncated entries (a
// runaway extension can flood this); ops watches for repeating signatures
// to know what to allowlist before flipping CSP_ENFORCE=true.
app.post('/api/csp-report', express.json({ type: ['application/csp-report', 'application/json'], limit: '32kb' }), (req, res) => {
  const r = req.body && (req.body['csp-report'] || req.body);
  if (r) {
    const fields = {
      blocked: String(r['blocked-uri'] || r.blockedURL || '').slice(0, 200),
      violated: String(r['violated-directive'] || r.effectiveDirective || '').slice(0, 80),
      docUri: String(r['document-uri'] || r.documentURL || '').slice(0, 200),
      source: String(r['source-file'] || r.sourceFile || '').slice(0, 200),
      line: r['line-number'] || r.lineNumber || null,
    };
    console.warn('[CSP] violation:', fields);
  }
  res.status(204).end();
});

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
        console.error(`[Fatal] CLIENT_URL contains wildcard "${o}" â€” refusing to start.`);
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

// Stamp every request with a correlation id (X-Request-ID). Sits before
// morgan so future log-format changes can include it, and before all body
// parsers/route handlers so any error log carries the same id we echo to
// the client in the error response body.
const requestId = require('./middleware/requestId');
app.use(requestId);

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

// â”€â”€â”€ Origin validation (CSRF-like protection for mutating requests) â”€â”€â”€â”€â”€â”€
// Runs in every environment except 'test'. The previous code only enforced
// in production, which meant a developer typo like "I'll just point this at
// `CLIENT_URL=*`" would never surface until prod boot â€” by which point the
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
    if (!raw) return next(); // server-to-server / curl â€” not subject to SOP

    let candidate;
    try {
      const u = new URL(raw);
      candidate = `${u.protocol}//${u.host}`;
    } catch {
      // Malformed Origin/Referer â€” refuse rather than silently allow.
      return res.status(403).json({ success: false, message: 'Malformed Origin/Referer header.' });
    }

    // Empty allowed list = development fallback; permit the request.
    if (allowedOrigins.length === 0) return next();
    if (allowedOrigins.includes(candidate)) return next();
    return res.status(403).json({ success: false, message: 'Request origin not allowed' });
  });
}

// â”€â”€â”€ Static file serving (uploads) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Phase 5e (audit P0-1): /uploads is now AUTHENTICATED. Token is accepted
// via Authorization: Bearer header OR ?token= query string so <img src=...>
// tags still work once the frontend appends the JWT. Anonymous requests
// receive 401. Per-file authorization remains a follow-up; this is the
// baseline gate that closes the public-file-by-filename-guess vulnerability.
const { getUploadDir } = require('./middleware/upload');
const { authenticateForStatic } = require('./middleware/staticAuth');
app.use('/uploads', authenticateForStatic, express.static(getUploadDir()));

// â”€â”€â”€ Upload config endpoint (tells frontend what's allowed) â”€
// INTENTIONALLY PUBLIC â€” returns only file extension/size limits (no secrets).
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

// â”€â”€â”€ Health checks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// /api/health = lightweight liveness probe. Used by the Docker HEALTHCHECK
// in deploy/Dockerfile.server. We deliberately do NOT hit the DB here â€” a
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

// â”€â”€â”€ Rate limiting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// General API rate limiter â€” broad safety net for /api/*. Combined with the
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

// P1-7 â€” Per-route mutation cap for label / reference / link endpoints.
// Falls under the global 300/min for total traffic but caps any single
// client at 60 mutations/minute on these specific surfaces. Without this
// a logged-in user could spam-create thousands of refs/links per minute,
// bloating the DB and the activity feed.
const mutationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('mutation'),
});

// â”€â”€â”€ API routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
// feat/docs-personal-notion Phase 4 â€” global active-user mention search.
// Mounted BEFORE the /api/users router so the `/mentions` sub-path doesn't
// get caught by users.js's `/:id` patterns (toggle-status, delete, etc).
const userMentionRoutes = require('./routes/userMentions');
app.use('/api/users/mentions', userMentionRoutes);
app.use('/api/users', userRoutes);
app.use('/api/timeplans', timePlanRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/search', searchLimiter, searchRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/teams', teamsRoutes);
app.use('/api/automations', automationRoutes);
// Workflow Canvas Phase W1 â€” sibling of /api/automations.
app.use('/api/workflows', workflowRoutes);
app.use('/api/forms', formRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/permissions', permissionRoutes);
app.use('/api/access-requests', accessRequestRoutes);
app.use('/api/task-extras', taskExtrasRoutes);
app.use('/api/announcements', announcementRoutes);
// P1-7 â€” mutationLimiter applied BEFORE the route handlers. Reads still
// fall under the global limiter; writes get the per-route cap.
app.use('/api/labels', mutationLimiter, labelRoutes);
// Phase 2 â€” Status Tile Group (status template) routes. Reads are open to
// anyone with board visibility (the controller gates); writes are restricted
// to Tier 1/Tier 2 in the controller (no board-creator carve-out). The
// mutationLimiter mirrors labels: a small per-route write cap on top of the
// per-user general limiter, since template writes are board-config changes.
app.use('/api/status-templates', mutationLimiter, statusTemplateRoutes);
app.use('/api/task-references', mutationLimiter, taskReferenceRoutes);
app.use('/api/task-links', mutationLimiter, taskLinkRoutes);
// Observability endpoint â€” admin-only operational metrics snapshot.
app.use('/api/metrics', metricsRoutes);
app.use('/api/extensions', extensionRoutes);
app.use('/api/help-requests', helpRequestRoutes);
app.use('/api/promotions', promotionRoutes);
app.use('/api/hierarchy-levels', hierarchyRoutes);
app.use('/api/manager-relations', managerRelationRoutes);
// /api/director-plan retired â€” return 410 Gone for any direct hits.
app.use('/api/director-plan', (_req, res) => res.status(410).json({ success: false, message: 'Director Plan module has been removed.' }));
app.use('/api/archive', archiveRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/integrations', integrationConfigRoutes);
app.use('/api/notes', noteRoutes);
// Doc Editor Phase B â€” collaborative documents inside a workspace.
//   /api/docs/:id family          â†’ flat routes for a single doc + versions
//   /api/docs (GET, POST)   â†’ personal list + create (feat/docs-personal-notion Phase 2).
//   /api/workspaces/:id/docs â†’ returns 410 Gone with a migration hint. Kept
//                              for one release so any pinned client (mobile
//                              app, third-party automation) gets a clear
//                              "use the new endpoint" instead of a 404.
const docRoutes = require('./routes/docs');
const { authenticate } = require('./middleware/auth');
app.use('/api/docs', docRoutes);
function docsWorkspaceRemoved(_req, res) {
  res.status(410).json({
    success: false,
    code: 'docs_workspace_removed',
    message: 'Docs are now personal â€” use /api/docs (list/create) instead.',
  });
}
app.get('/api/workspaces/:workspaceId/docs', authenticate, docsWorkspaceRemoved);
app.post('/api/workspaces/:workspaceId/docs', authenticate, docsWorkspaceRemoved);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/transcription', transcriptionRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/outbound-webhooks', outboundWebhookRoutes);
app.use('/api/recurring-tasks', recurringTaskRoutes);
app.use('/api/board-orders', boardOrderRoutes);
app.use('/api/system-settings', systemSettingsRoutes);
// Tier-1 DB backup management. Mounted at /api/admin/backups so the URL
// space makes the privilege level obvious to anyone reading nginx logs.
app.use('/api/admin/backups', adminBackupsRoutes);
app.use('/api/meeting-stream', meetingStreamRoutes);
// Doc Editor Phase G â€” collab ticket endpoint. Mirrors meeting-stream
// ticket: short-lived JWT (60s) used to authenticate the WS upgrade
// on /api/docs-collab/ws.
const docCollabRoutes = require('./routes/docCollab');
app.use('/api/docs-collab', docCollabRoutes);
// Slice 5b: authenticated desktop installer download + version manifest.
// File payload lives at server/downloads/desktop/Monday-Aniston-Setup.exe,
// populated by `npm run desktop:publish`.
app.use('/api/desktop', desktopDownloadRoutes);

// â”€â”€â”€ Multi-manager relation routes (inline for reliable loading) â”€â”€â”€
// /api/multi-manager/* â€” the legacy alias the OrgChartPage actually calls on
// drag-drop. Audit B4 fix: this surface previously lacked requirePermission,
// so a Tier-2 user with an explicit DENY override could still mutate the
// chart here even though the canonical /api/promotions/relations/* path was
// gated. Now matches the canonical gates 1:1.
const { authenticate: mrAuth, managerOrAdmin: mrMgr } = require('./middleware/auth');
const { requirePermission: mrPerm } = require('./middleware/permissions');
const mrCtrl = require('./controllers/managerRelationController');
app.get('/api/multi-manager/:employeeId', mrAuth, mrPerm('org_chart', 'view'), mrCtrl.getRelationsForEmployee);
app.post('/api/multi-manager', mrAuth, mrMgr, mrPerm('org_chart', 'manage'), mrCtrl.addRelation);
app.put('/api/multi-manager/:id', mrAuth, mrMgr, mrPerm('org_chart', 'manage'), mrCtrl.updateRelation);
app.delete('/api/multi-manager/:id', mrAuth, mrMgr, mrPerm('org_chart', 'manage'), mrCtrl.removeRelation);
app.post('/api/multi-manager/sync', mrAuth, mrMgr, mrPerm('org_chart', 'manage'), mrCtrl.syncFromManagerId);

// Dependency routes mounted at /api (uses router.use(authenticate) â€” must be LAST)
app.use('/api', dependencyRoutes);

// â”€â”€â”€ Boot-time route registration check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  // Workspace-order (Rearrange Workspaces) routes â€” same paranoia as above.
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

// â”€â”€â”€ 404 handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// In development, include the method and path in the response so a stale
// route registration is obvious from the network panel. In production, keep
// the response generic to avoid leaking the API surface to unauthenticated
// scanners.
app.use((req, res) => {
  const isDev = process.env.NODE_ENV !== 'production';
  // Always log the unmatched request â€” this is the single most useful
  // diagnostic when "Route not found" comes back.
  console.warn(`[Server] 404 ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    success: false,
    message: 'Route not found.',
    ...(isDev ? { method: req.method, path: req.originalUrl } : {}),
  });
});

// â”€â”€â”€ Global error handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Centralized in middleware/errorHandler.js. Classifies the thrown error
// into a stable code + safe user-facing message, redacts secrets from the
// server-side log, and never leaks stack traces, SQL fragments, or column
// names to the client. Response shape is backward-compatible (top-level
// `message`/`errors`/`code` preserved) with an additive `error` envelope
// carrying { code, message, requestId, details? } for new frontend code.
app.use(require('./middleware/errorHandler'));

// â”€â”€â”€ Start server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PORT = parseInt(process.env.PORT, 10) || 5000;

const start = async () => {
  try {
    // Test DB connection
    await testConnection();

    // â”€â”€ Auto-migration: Convert tasks.status from ENUM to VARCHAR(50) â”€â”€
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
        console.log('[Server] tasks.status is already VARCHAR â€” no ENUM conversion needed.');
      }
    } catch (e) {
      console.warn('[Server] Status ENUM migration warning:', e.message?.slice(0, 120));
    }

    // â”€â”€ Auto-migration: Add statusConfig JSONB column to tasks â”€â”€
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
      // Ignore â€” type may not exist yet or value already exists
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
      'time_block_reminder',
    ]) {
      try {
        await sequelize.query(`ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS '${val}';`);
      } catch (e) { /* already exists or type not created yet */ }
    }
    console.log('[Server] Notification type ENUM extended (reminders + priority_change + governance).');

    // â”€â”€ Auto-migration: help_requests.rejectionReason â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Captured when a helper declines a request so the requester sees the
    // reason instead of a silent rejection. Added defensively via
    // ADD COLUMN IF NOT EXISTS so older deploys without this column upgrade
    // cleanly on next boot.
    try {
      await sequelize.query(
        `ALTER TABLE help_requests ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT`
      );
    } catch (e) {
      console.warn('[Server] help_requests.rejectionReason migration warn:', e.message);
    }

    // â”€â”€ Auto-migration: push_subscriptions table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // DB-backed VAPID push subscriptions. Replaces the previous in-memory Map
    // in services/pushService.js so subscriptions survive restart and aren't
    // split across replicas. Endpoint is globally unique â€” same browser maps
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

    // â”€â”€ Auto-migration: notifications performance indexes â”€â”€â”€â”€â”€
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

    // â”€â”€ Auto-migration: task_reminders extension (offset / custom) â”€â”€â”€â”€â”€â”€
    // Phase 5 (task-level reminders). Adds two nullable columns and replaces
    // the legacy `(taskId, reminderType)` unique constraint with an
    // expression-based one that includes offsetMinutes + customReminderAt so
    // multiple offset reminders (e.g. "1 day before" AND "1 hour before") on
    // the same task are allowed, while a duplicate (same task + same offset)
    // is still blocked at the DB level.
    try {
      await sequelize.query(`ALTER TABLE task_reminders
        ADD COLUMN IF NOT EXISTS "offsetMinutes" INTEGER DEFAULT NULL`);
      await sequelize.query(`ALTER TABLE task_reminders
        ADD COLUMN IF NOT EXISTS "customReminderAt" TIMESTAMP WITH TIME ZONE DEFAULT NULL`);
      // Drop the legacy strict unique on (taskId, reminderType). Two ways
      // it might exist: as a UNIQUE CONSTRAINT (older Sequelize sync) or as
      // a UNIQUE INDEX (newer migration). Try both, ignore errors.
      await sequelize.query(`ALTER TABLE task_reminders
        DROP CONSTRAINT IF EXISTS idx_task_reminder_unique`).catch(() => {});
      await sequelize.query(`DROP INDEX IF EXISTS idx_task_reminder_unique`).catch(() => {});
      // New expression-based dedup. Postgres treats two NULLs as distinct in
      // a unique index, so we COALESCE both nullable columns to a sentinel
      // value the user can never legitimately pass. -1 is unreachable as a
      // minute offset (we validate >0 server-side); '1970-01-01 UTC' is
      // unreachable as a future reminder timestamp.
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_reminder_dedup
        ON task_reminders (
          "taskId",
          "reminderType",
          COALESCE("offsetMinutes", -1),
          COALESCE("customReminderAt", '1970-01-01 00:00:00+00'::timestamptz)
        )`);
      console.log('[Server] task_reminders Phase 5 migration ensured.');
    } catch (e) {
      console.warn('[Server] task_reminders Phase 5 migration warning:', e.message?.slice(0, 200));
    }

    // â”€â”€ Auto-migration: task_reminders recurring types (interval / daily_times) â”€â”€
    // Adds the fields needed for repeat-until-done reminders. The two new
    // reminderType values store either an `intervalMinutes` period or a
    // JSONB `timesOfDay` array (in `timezone`). `lastFiredAt` is audit-only.
    // All ADDs are nullable + idempotent so a re-run is a no-op.
    try {
      await sequelize.query(`ALTER TABLE task_reminders
        ADD COLUMN IF NOT EXISTS "intervalMinutes" INTEGER DEFAULT NULL`);
      await sequelize.query(`ALTER TABLE task_reminders
        ADD COLUMN IF NOT EXISTS "timesOfDay" JSONB DEFAULT NULL`);
      await sequelize.query(`ALTER TABLE task_reminders
        ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT NULL`);
      await sequelize.query(`ALTER TABLE task_reminders
        ADD COLUMN IF NOT EXISTS "lastFiredAt" TIMESTAMP WITH TIME ZONE DEFAULT NULL`);
      console.log('[Server] task_reminders recurring-types migration ensured.');
    } catch (e) {
      console.warn('[Server] task_reminders recurring-types migration warning:', e.message?.slice(0, 200));
    }

    // ── Auto-migration: time_blocks planner fields (migration 023) ──────────
    // Time Planner upgrade. All columns nullable or defaulted so legacy rows
    // remain valid and render unchanged. Mirrors migrations/023_*.sql.
    try {
      await sequelize.query(`ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "title" VARCHAR(300)`);
      await sequelize.query(`ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "type" VARCHAR(30) NOT NULL DEFAULT 'task_work'`);
      await sequelize.query(`ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'planned'`);
      await sequelize.query(`ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "priority" VARCHAR(20) NOT NULL DEFAULT 'normal'`);
      await sequelize.query(`ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "source" VARCHAR(20) NOT NULL DEFAULT 'manual'`);
      await sequelize.query(`ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "reminderMinutesBefore" INTEGER`);
      await sequelize.query(`ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "createdById" UUID REFERENCES users(id) ON DELETE SET NULL`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS time_blocks_created_by_id ON time_blocks ("createdById")`);
      await sequelize.query(`UPDATE time_blocks SET "source" = 'task' WHERE "taskId" IS NOT NULL AND "source" = 'manual'`).catch(() => {});
      console.log('[Server] time_blocks planner-fields migration ensured.');
    } catch (e) {
      console.warn('[Server] time_blocks planner-fields migration warning:', e.message?.slice(0, 200));
    }

    // ── Auto-migration: time_blocks calendar upgrade (migration 024) ────────
    // Rich description (TEXT) + bounded recurrence (rule + group id). Additive.
    try {
      await sequelize.query(`ALTER TABLE time_blocks ALTER COLUMN "description" TYPE TEXT`).catch(() => {});
      await sequelize.query(`ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "recurrenceRule" VARCHAR(50)`);
      await sequelize.query(`ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "recurrenceGroupId" UUID`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS time_blocks_recurrence_group ON time_blocks ("recurrenceGroupId")`);
      console.log('[Server] time_blocks calendar-upgrade migration ensured.');
    } catch (e) {
      console.warn('[Server] time_blocks calendar-upgrade migration warning:', e.message?.slice(0, 200));
    }

    // ── Auto-migration: time_blocks colour + reminder dedupe (migration 025) ─
    try {
      await sequelize.query(`ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "color" VARCHAR(20)`);
      await sequelize.query(`ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP WITH TIME ZONE`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS time_blocks_reminder_due ON time_blocks ("reminderSentAt") WHERE "reminderMinutesBefore" IS NOT NULL AND "reminderSentAt" IS NULL`);
      console.log('[Server] time_blocks colour/reminder migration ensured.');
    } catch (e) {
      console.warn('[Server] time_blocks colour/reminder migration warning:', e.message?.slice(0, 200));
    }

    // â”€â”€ Auto-migration: notifications.idempotencyKey column + partial unique index â”€
    // Phase 3 (Notification system fix pass). Adds the column used by the
    // centralised notificationService.createNotification() to deduplicate
    // logical events across concurrent callers, retries, and cron ticks.
    //
    // The unique index is PARTIAL (`WHERE "idempotencyKey" IS NOT NULL`) so
    // legacy callers that omit the key continue to work â€” multiple NULL rows
    // are allowed. Adding the column is non-blocking under normal load
    // (`ADD COLUMN ... DEFAULT NULL` is metadata-only in modern Postgres).
    try {
      await sequelize.query(`ALTER TABLE notifications
        ADD COLUMN IF NOT EXISTS "idempotencyKey" VARCHAR(120) DEFAULT NULL`);
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idempotency
        ON notifications ("userId", "idempotencyKey")
        WHERE "idempotencyKey" IS NOT NULL`);
      console.log('[Server] notifications.idempotencyKey column ensured.');
    } catch (e) {
      console.warn('[Server] notifications.idempotencyKey migration warning:', e.message?.slice(0, 200));
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

      // â”€â”€ One-shot legacy backfill (gated) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      //
      // These two INSERTs migrate pre-junction-table data into task_assignees:
      //   1. Every task whose legacy `tasks.assignedTo` is set gets a matching
      //      ('assignee') row.
      //   2. Every existing task_owners row gets a matching ('assignee') row.
      // Both used ON CONFLICT DO NOTHING and were intended to be idempotent.
      //
      // BUT: running them on every deploy creates a subtle restoration vector.
      // If an assignee was removed via a path that cleared task_assignees but
      // NOT the legacy `tasks.assignedTo` column (e.g. an out-of-band psql
      // edit, a now-fixed controller bug, or a one-off script), the next
      // backend restart silently re-inserts the assignee â€” making it look
      // like deleted data is "coming back" after a deploy.
      //
      // For mature installs (production), the backfill has long since
      // completed. Gate it behind `system_flags.task_assignees_legacy_backfill_v1`
      // â€” same pattern as the BoardMembers.autoAdded cleanup further below.
      // The first deploy after this code lands runs the INSERTs once and
      // writes the marker. All subsequent deploys short-circuit via a
      // single SELECT and the restoration vector is closed.
      //
      // Fresh / dev databases still get the legacy data migrated on first
      // boot. We log a clear summary of how many rows the backfill touched
      // so operators see exactly what happened.
      try {
        await sequelize.query(`
          CREATE TABLE IF NOT EXISTS system_flags (
            flag VARCHAR(100) PRIMARY KEY,
            completed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            details JSONB DEFAULT '{}'
          )
        `);
        const [taFlagRows] = await sequelize.query(
          `SELECT flag FROM system_flags WHERE flag = 'task_assignees_legacy_backfill_v1'`
        );
        if (taFlagRows.length === 0) {
          const [, fromAssignedToMeta] = await sequelize.query(`
            INSERT INTO task_assignees ("taskId", "userId", role, "assignedAt", "createdAt", "updatedAt")
            SELECT t.id, t."assignedTo", 'assignee', COALESCE(t."createdAt", NOW()), NOW(), NOW()
            FROM tasks t WHERE t."assignedTo" IS NOT NULL
            ON CONFLICT ("taskId", "userId", role) DO NOTHING
          `);
          const [, fromOwnersMeta] = await sequelize.query(`
            INSERT INTO task_assignees ("taskId", "userId", role, "assignedAt", "createdAt", "updatedAt")
            SELECT o."taskId", o."userId", 'assignee', COALESCE(o."createdAt", NOW()), NOW(), NOW()
            FROM task_owners o WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = o."taskId")
            ON CONFLICT ("taskId", "userId", role) DO NOTHING
          `);
          const fromAssignedTo = fromAssignedToMeta?.rowCount ?? 0;
          const fromOwners = fromOwnersMeta?.rowCount ?? 0;
          console.log(`[Server] task_assignees legacy backfill v1 ran: assignedToâ†’${fromAssignedTo}, task_ownersâ†’${fromOwners}.`);
          await sequelize.query(
            `INSERT INTO system_flags (flag, completed_at, details)
             VALUES ('task_assignees_legacy_backfill_v1', NOW(), $1)
             ON CONFLICT (flag) DO NOTHING`,
            { bind: [JSON.stringify({ fromAssignedTo, fromOwners })] }
          );
          console.log('[Server] task_assignees legacy backfill v1 marked complete in system_flags.');
        } else {
          // Subsequent boots: explicit skip log so the absence of a backfill
          // line in deploy output is not mistaken for a missing migration.
          console.log('[Server] task_assignees legacy backfill v1 already complete â€” skipping.');
        }
      } catch (e) {
        console.warn('[Server] task_assignees legacy backfill v1 warning:', e.message?.slice(0, 200));
      }
      console.log('[Server] task_assignees table ensured.');
    } catch (e) {
      console.warn('[Server] task_assignees migration warning:', e.message?.slice(0, 100));
    }

    // â”€â”€ Auto-migration: pending_login_tokens table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Single-active-session feature. One row per "you're already logged in
    // somewhere â€” click to take over" confirmation handshake. Raw token is
    // returned ONCE to the client; only its SHA-256 hash lives here.
    //
    // Idempotent: every statement uses IF NOT EXISTS. Non-destructive: no
    // existing data is altered.
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS pending_login_tokens (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId"      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash    VARCHAR(64) NOT NULL,
        expires_at    TIMESTAMP WITH TIME ZONE NOT NULL,
        used_at       TIMESTAMP WITH TIME ZONE,
        ip            VARCHAR(45),
        user_agent    VARCHAR(255),
        origin        VARCHAR(16) NOT NULL DEFAULT 'local',
        "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      // Partial index: tokenHash is only ever looked up among unused, unexpired
      // rows. Filtering at the index level keeps it tight and cheap as old
      // rows accumulate. lookups also still work without it via the secondary
      // (token_hash) index below.
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_plt_hash
        ON pending_login_tokens (token_hash)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_plt_user
        ON pending_login_tokens ("userId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_plt_expires
        ON pending_login_tokens (expires_at)`);
      console.log('[Server] pending_login_tokens table ensured.');
    } catch (e) {
      console.warn('[Server] pending_login_tokens migration warning:', e.message?.slice(0, 200));
    }

    // â”€â”€ Auto-migration: user_board_orders table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Per-user board ordering inside workspaces (sidebar Rearrange feature).
    // Idempotent â€” safe to run on every boot.
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

    // â”€â”€ Auto-migration: user_workspace_orders table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Per-user workspace ordering for the sidebar (Rearrange Workspaces).
    // Idempotent â€” safe to run on every boot. ON DELETE CASCADE is critical
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

    // â”€â”€ Auto-migration: task_approval_flows table + stage column â”€â”€
    // Self-installing DDL â€” mirrors server/scripts/create-task-approval-flow.js
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

      // Defensive ADD COLUMN â€” covers the case where an older deploy created
      // the table before `stage` existed. Backfill stage = level so existing
      // in-flight chains route through findCurrentStageRows correctly.
      await sequelize.query(`ALTER TABLE task_approval_flows ADD COLUMN IF NOT EXISTS stage INTEGER`);
      await sequelize.query(`UPDATE task_approval_flows SET stage = level WHERE stage IS NULL`);

      // All four indexes from the model definition. The unique (taskId, level)
      // index is load-bearing â€” submitForApproval relies on it to prevent
      // duplicate level rows under concurrent submissions.
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS task_approval_flows_task_level_unique
        ON task_approval_flows ("taskId", level)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS task_approval_flows_task_status_idx
        ON task_approval_flows ("taskId", status)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS task_approval_flows_user_status_idx
        ON task_approval_flows ("userId", status)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS task_approval_flows_task_stage_status_idx
        ON task_approval_flows ("taskId", stage, status)`);

      // Verification â€” log the column set so an operator can confirm the
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

    // â”€â”€ Auto-migration: permission_grants schema upgrades (008) â”€â”€
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

    // â”€â”€ Auto-migration 017: permission_grants UNIQUE active-override â”€â”€
    //
    // Phase A (May 2026 RBAC hardening). Adds a partial UNIQUE index that
    // prevents two ACTIVE rows from sharing the same
    // (userId, resourceType, resourceId, action, effect) tuple. Without
    // this, concurrent POST /api/permissions calls can race past the
    // controller's idempotency check and persist two ACTIVE rows; a
    // subsequent DELETE only revokes one, leaving the engine flapping
    // between grant-and-grant or deny-and-deny.
    //
    // Safety: skips installation if duplicates already exist. The bundled
    // dedupe-permission-grants script handles cleanup with soft
    // deactivation (no hard delete). The index name is namespaced so a
    // future migration can extend it without colliding with the legacy
    // non-unique indexes installed above.
    //
    // COALESCE handles NULL resourceId (global grants) and NULL action
    // (legacy permissionLevel-only rows) so two globals don't dodge the
    // uniqueness constraint via SQL's NULL = NULL = UNKNOWN semantics.
    try {
      const [pgTablesUniq] = await sequelize.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'permission_grants'`
      );
      if (pgTablesUniq.length > 0) {
        const [dupRows] = await sequelize.query(`
          SELECT COUNT(*)::int AS n FROM (
            SELECT "userId", "resourceType",
                   COALESCE("resourceId"::text, ''),
                   COALESCE(action, ''),
                   effect
            FROM permission_grants
            WHERE "isActive" = true
            GROUP BY 1, 2, 3, 4, 5
            HAVING COUNT(*) > 1
          ) d
        `);
        const dupCount = Number(dupRows?.[0]?.n || 0);
        if (dupCount > 0) {
          console.warn(
            `[Server] permission_grants UNIQUE active-override index NOT installed: ${dupCount} ` +
            `duplicate ACTIVE tuple(s) present. Run \`node server/scripts/dedupe-permission-grants.js --apply\` ` +
            `then restart to apply the constraint. Engine still functions; race-condition duplicates remain ` +
            `possible until cleaned up.`
          );
        } else {
          await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_permission_grants_active_override
              ON permission_grants (
                "userId",
                "resourceType",
                COALESCE("resourceId"::text, ''),
                COALESCE(action, ''),
                effect
              )
              WHERE "isActive" = true
          `);
          console.log('[Server] permission_grants UNIQUE active-override index ensured.');
        }
      }
    } catch (e) {
      console.warn('[Server] permission_grants UNIQUE constraint warning:', e.message?.slice(0, 200));
    }

    // â”€â”€ Auto-migration: labels and task_labels tables â”€â”€
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

    // â”€â”€ Auto-migration: status_templates (Phase 2 â€” board-scoped status
    // tile groups). Mirrors server/migrations/020_status_templates.sql.
    // Idempotent so every restart is a no-op once the table is in place.
    // Cascade on board delete; partial unique index keeps the "one default
    // per board" invariant at the DB layer even under a race condition.
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS status_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "boardId" UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        statuses JSONB NOT NULL DEFAULT '[]'::jsonb,
        "defaultStatusKey" VARCHAR(50) NOT NULL,
        "isDefault" BOOLEAN NOT NULL DEFAULT false,
        "createdBy" UUID NOT NULL REFERENCES users(id),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_status_templates_board
        ON status_templates("boardId")`);
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_status_templates_board_default_one
        ON status_templates("boardId")
        WHERE "isDefault" = true`);
      console.log('[Server] status_templates table + indices ensured.');
    } catch (e) {
      console.warn('[Server] status_templates migration warning:', e.message?.slice(0, 100));
    }

    // â”€â”€ Auto-migration: docs + doc_versions (Doc Editor Phase B).
    // Idempotent CREATE-IF-NOT-EXISTS for both tables plus the workspace +
    // archive indexes the doc list page reads. Mirrors server/models/Doc.js
    // and server/models/DocVersion.js â€” Sequelize sync({alter:false}) won't
    // touch existing tables, so this DDL is the source of truth at boot.
    //
    // Note: the sharePolicy enum is declared inline because Sequelize's
    // ENUM type generates an enum value Postgres reuses â€” we want the same
    // value-set whether the table was created here or via sync.
    try {
      await sequelize.query(`DO $$ BEGIN
        CREATE TYPE doc_share_policy AS ENUM ('private', 'workspace', 'public_link');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
      await sequelize.query(`CREATE TABLE IF NOT EXISTS docs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workspaceId" UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title VARCHAR(300) NOT NULL DEFAULT 'Untitled doc',
        "contentJson" JSONB NOT NULL DEFAULT '{"type":"doc","content":[]}'::jsonb,
        "contentText" TEXT NOT NULL DEFAULT '',
        slug VARCHAR(180),
        "sharePolicy" doc_share_policy NOT NULL DEFAULT 'workspace',
        "isArchived" BOOLEAN NOT NULL DEFAULT false,
        "archivedAt" TIMESTAMP WITH TIME ZONE,
        "archivedBy" UUID,
        "createdBy" UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
        "lastEditedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
        "lastEditedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_docs_workspace
        ON docs("workspaceId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_docs_creator
        ON docs("createdBy")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_docs_archived
        ON docs("isArchived")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_docs_slug
        ON docs(slug)`);
      // Trigram index for plain-text search across all docs the caller can
      // see. The `contentText` column is server-derived from contentJson on
      // save so the index reflects rendered content, not raw JSON keys.
      await sequelize.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_docs_text_trgm
        ON docs USING gin("contentText" gin_trgm_ops)`);

      await sequelize.query(`CREATE TABLE IF NOT EXISTS doc_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "docId" UUID NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        "contentJson" JSONB NOT NULL,
        "contentText" TEXT NOT NULL DEFAULT '',
        "savedBy" UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
        note VARCHAR(200),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_doc_versions_doc
        ON doc_versions("docId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_doc_versions_doc_time
        ON doc_versions("docId", "createdAt" DESC)`);

      // Doc Editor Phase D Slice 1 â€” @-mentions per doc. Unique on
      // (docId, mentionedUserId) so the same user can't have two rows
      // for the same doc; updateDoc relies on that uniqueness when
      // diffing mentions between saves.
      await sequelize.query(`CREATE TABLE IF NOT EXISTS doc_mentions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "docId" UUID NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        "mentionedUserId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "mentionedByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
        "anchorOffset" INTEGER,
        "resolvedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_doc_mentions_doc
        ON doc_mentions("docId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_doc_mentions_user
        ON doc_mentions("mentionedUserId")`);
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_mentions_doc_user
        ON doc_mentions("docId", "mentionedUserId")`);

      // Doc Editor Phase D Slice 2 â€” task chips per doc.
      // Unique on (docId, taskId) so the same task can't have two
      // rows for the same doc. CASCADE on both ends so deleting either
      // the doc or the task removes the link cleanly.
      await sequelize.query(`CREATE TABLE IF NOT EXISTS doc_task_references (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "docId" UUID NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "addedByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
        "anchorOffset" INTEGER,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_doc_task_refs_doc
        ON doc_task_references("docId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_doc_task_refs_task
        ON doc_task_references("taskId")`);
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_task_refs_doc_task
        ON doc_task_references("docId", "taskId")`);

      // Doc Editor Phase F â€” selection-anchored comments + replies.
      // Self-referential FK on parentId (replies hang off top-level
      // comments). CASCADE through doc â†’ comments and parent â†’ replies
      // so archiving/deleting a doc cleans up its threads, and deleting
      // a parent wipes orphan children. Author / resolver FKs SET NULL
      // so historical threads survive user deletion.
      await sequelize.query(`CREATE TABLE IF NOT EXISTS doc_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "docId" UUID NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        "parentId" UUID REFERENCES doc_comments(id) ON DELETE CASCADE,
        "authorId" UUID REFERENCES users(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        "anchorText" TEXT NOT NULL,
        "anchorFrom" INTEGER,
        "anchorTo" INTEGER,
        resolved BOOLEAN NOT NULL DEFAULT false,
        "resolvedAt" TIMESTAMP WITH TIME ZONE,
        "resolvedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_doc_comments_doc
        ON doc_comments("docId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_doc_comments_doc_resolved
        ON doc_comments("docId", resolved)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_doc_comments_parent
        ON doc_comments("parentId")`);

      // Doc Editor Phase G â€” Y.js CRDT state column. BYTEA; populated by
      // Hocuspocus onStoreDocument. NULL on existing rows that predate
      // collab; the service either rejects collab for non-trivial legacy
      // docs (no auto-migration) or starts fresh for empty docs.
      await sequelize.query(`ALTER TABLE docs
        ADD COLUMN IF NOT EXISTS "yjsState" BYTEA`);

      console.log('[Server] docs + doc_versions + doc_mentions + doc_task_references + doc_comments tables + indices ensured.');
    } catch (e) {
      console.warn('[Server] docs migration warning:', e.message?.slice(0, 200));
    }

    // â”€â”€ feat/docs-personal-notion Phase 2 â€” personal docs primitives. â”€â”€
    //
    // What this block does (all idempotent / additive â€” re-runnable on every
    // boot without side effects):
    //   1. Makes docs.workspaceId nullable. New personal docs leave it NULL;
    //      existing rows keep their workspaceId as legacy metadata.
    //   2. Adds ownerUserId, visibility, contentFormat, legacyContentJson
    //      columns to docs.
    //   3. Adds anchorBlockId to doc_comments (Phase 6 BlockNote anchoring).
    //   4. Adds contentFormat to doc_versions so snapshot restore knows
    //      whether to feed Tiptap or BlockNote.
    //   5. Creates the doc_access table â€” explicit per-user grants. Replaces
    //      the canCallerSeeWorkspace workspace/board/role fallback as the
    //      canonical "can this user see this doc" resolver.
    //   6. Backfills (one-shot, gated by system_flags.docs_personal_phase2_v1
    //      so subsequent boots skip the scan entirely):
    //        a. docs.ownerUserId  â† docs.createdBy
    //        b. docs.contentFormat='tiptap_json' for rows that pre-date the
    //           deploy (gated by legacyContentJson IS NULL + a one-shot flag
    //           so re-runs don't re-flip new BlockNote docs)
    //        c. doc_access owner rows for every owned doc
    //        d. doc_access legacy_workspace rows preserving CURRENT effective
    //           access for every workspace-creator, workspace-member,
    //           board-member, and admin/manager â€” so no user loses access at
    //           the moment of cutover (option (b) from the migration plan).
    //
    // Rollback story:
    //   - Code revert reinstates canCallerSeeWorkspace and lists the old
    //     workspace-nested routes. Schema additions stay (harmless additive
    //     columns + one new table). The 'docs_personal_phase2_v1' system_flags
    //     row stays as proof the backfill ran â€” re-running the migration on
    //     a later re-deploy will skip the backfill block.
    //   - The owner backfill is non-destructive: docs.createdBy is unchanged.
    //   - legacy_workspace rows can be hand-pruned with a single DELETE on
    //     `source='legacy_workspace'` if a clean cutover is desired.
    try {
      // 1. Nullable workspaceId.
      await sequelize.query(`ALTER TABLE docs ALTER COLUMN "workspaceId" DROP NOT NULL`);
      // 2. New docs columns.
      await sequelize.query(`ALTER TABLE docs
        ADD COLUMN IF NOT EXISTS "ownerUserId" UUID REFERENCES users(id) ON DELETE SET NULL`);
      await sequelize.query(`ALTER TABLE docs
        ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'private'`);
      await sequelize.query(`ALTER TABLE docs
        ADD COLUMN IF NOT EXISTS "contentFormat" VARCHAR(16) NOT NULL DEFAULT 'blocknote_json'`);
      await sequelize.query(`ALTER TABLE docs
        ADD COLUMN IF NOT EXISTS "legacyContentJson" JSONB`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_docs_owner_user
        ON docs("ownerUserId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_docs_visibility
        ON docs(visibility)`);

      // 3. doc_comments + doc_versions additions.
      await sequelize.query(`ALTER TABLE doc_comments
        ADD COLUMN IF NOT EXISTS "anchorBlockId" VARCHAR(40)`);
      await sequelize.query(`ALTER TABLE doc_versions
        ADD COLUMN IF NOT EXISTS "contentFormat" VARCHAR(16) NOT NULL DEFAULT 'tiptap_json'`);

      // 4. doc_access table.
      await sequelize.query(`CREATE TABLE IF NOT EXISTS doc_access (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "docId" UUID NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "accessLevel" VARCHAR(16) NOT NULL DEFAULT 'view'
          CHECK ("accessLevel" IN ('owner','edit','comment','view')),
        source VARCHAR(20) NOT NULL DEFAULT 'manual_share'
          CHECK (source IN ('owner','mention','manual_share','legacy_workspace')),
        "grantedByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_access_doc_user
        ON doc_access("docId", "userId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_doc_access_user
        ON doc_access("userId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_doc_access_doc
        ON doc_access("docId")`);

      // 5. One-time backfill â€” gated by system_flags so it runs exactly once
      //    across this codebase's lifetime regardless of boot count.
      await sequelize.query(`CREATE TABLE IF NOT EXISTS system_flags (
        flag TEXT PRIMARY KEY,
        completed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        details JSONB DEFAULT '{}'
      )`);
      const [flagRows] = await sequelize.query(
        `SELECT flag FROM system_flags WHERE flag = 'docs_personal_phase2_v1'`
      );
      if (flagRows.length === 0) {
        const counts = { ownerBackfill: 0, formatFlip: 0, ownerAccess: 0, wsCreators: 0, wsMembers: 0, boardMembers: 0, admins: 0 };

        // 5a. ownerUserId â† createdBy
        const [, r1] = await sequelize.query(`
          UPDATE docs SET "ownerUserId" = "createdBy"
          WHERE "ownerUserId" IS NULL AND "createdBy" IS NOT NULL
        `);
        counts.ownerBackfill = r1?.rowCount ?? 0;

        // 5b. Existing rows â†’ tiptap_json. Guarded by legacyContentJson IS NULL
        //     so any doc the user later converts in Phase 6 keeps its post-
        //     conversion format. Also gated implicitly by this whole block
        //     running once (system_flags guard above).
        const [, r2] = await sequelize.query(`
          UPDATE docs SET "contentFormat" = 'tiptap_json'
          WHERE "contentFormat" = 'blocknote_json'
            AND "legacyContentJson" IS NULL
        `);
        counts.formatFlip = r2?.rowCount ?? 0;

        // 5c. Owner rows.
        const [, r3] = await sequelize.query(`
          INSERT INTO doc_access ("docId", "userId", "accessLevel", source)
          SELECT id, "ownerUserId", 'owner', 'owner' FROM docs
          WHERE "ownerUserId" IS NOT NULL
          ON CONFLICT ("docId", "userId") DO NOTHING
        `);
        counts.ownerAccess = r3?.rowCount ?? 0;

        // 5d. Workspace creator (legacy_workspace).
        const [, r4] = await sequelize.query(`
          INSERT INTO doc_access ("docId", "userId", "accessLevel", source)
          SELECT d.id, w."createdBy", 'comment', 'legacy_workspace'
          FROM docs d JOIN workspaces w ON w.id = d."workspaceId"
          WHERE w."createdBy" IS NOT NULL
            AND w."createdBy" <> COALESCE(d."ownerUserId", '00000000-0000-0000-0000-000000000000'::uuid)
          ON CONFLICT ("docId", "userId") DO NOTHING
        `);
        counts.wsCreators = r4?.rowCount ?? 0;

        // 5e. Workspace members (users.workspaceId = ws.id).
        const [, r5] = await sequelize.query(`
          INSERT INTO doc_access ("docId", "userId", "accessLevel", source)
          SELECT d.id, u.id, 'comment', 'legacy_workspace'
          FROM docs d JOIN users u ON u."workspaceId" = d."workspaceId"
          WHERE u."isActive" = true
            AND u.id <> COALESCE(d."ownerUserId", '00000000-0000-0000-0000-000000000000'::uuid)
          ON CONFLICT ("docId", "userId") DO NOTHING
        `);
        counts.wsMembers = r5?.rowCount ?? 0;

        // 5f. Board members (the May 2026 board-membership fallback).
        const [, r6] = await sequelize.query(`
          INSERT INTO doc_access ("docId", "userId", "accessLevel", source)
          SELECT DISTINCT d.id, bm."userId", 'comment', 'legacy_workspace'
          FROM docs d
          JOIN boards b ON b."workspaceId" = d."workspaceId" AND b."isArchived" = false
          JOIN "BoardMembers" bm ON bm."boardId" = b.id
          WHERE bm."userId" <> COALESCE(d."ownerUserId", '00000000-0000-0000-0000-000000000000'::uuid)
          ON CONFLICT ("docId", "userId") DO NOTHING
        `);
        counts.boardMembers = r6?.rowCount ?? 0;

        // 5g. Admins/managers (role bypass that canCallerSeeWorkspace honored).
        //     Backfilling them now preserves their CURRENT access for the
        //     docs that exist today; from Phase 2 onwards, role no longer
        //     auto-grants access for NEW docs.
        const [, r7] = await sequelize.query(`
          INSERT INTO doc_access ("docId", "userId", "accessLevel", source)
          SELECT d.id, u.id, 'comment', 'legacy_workspace'
          FROM docs d CROSS JOIN users u
          WHERE u."isActive" = true
            AND u.role IN ('admin','manager')
            AND u.id <> COALESCE(d."ownerUserId", '00000000-0000-0000-0000-000000000000'::uuid)
          ON CONFLICT ("docId", "userId") DO NOTHING
        `);
        counts.admins = r7?.rowCount ?? 0;

        await sequelize.query(
          `INSERT INTO system_flags (flag, completed_at, details)
           VALUES ('docs_personal_phase2_v1', NOW(), $1)
           ON CONFLICT (flag) DO NOTHING`,
          { bind: [JSON.stringify(counts)] }
        );
        console.log('[Server] docs_personal_phase2 backfill complete:', counts);
      }

      console.log('[Server] docs personal-phase2 schema + backfill ensured.');

      // â”€ Owner-row hygiene (docs_personal_phase2_owner_hygiene_v1) â”€
      // The phase-2 backfill above could insert BOTH an owner-row AND a
      // legacy_workspace 'comment' row for the same (docId, userId) â€” the
      // creator-of-workspace and admins/managers branches don't exclude
      // the doc's own owner unless ownerUserId was set at the time the
      // backfill ran. Resolver-side that's harmless (the owner check
      // returns 'owner' before consulting the table), but it pollutes the
      // Share-panel display ("Owner" row collides with a "from old
      // workspace Â· comment" row for the same person).
      //
      // This cleanup is non-destructive â€” it removes ONLY duplicate
      // legacy_workspace rows for the doc's own owner. It never touches
      // legacy rows for non-owners (those are real, preserved access),
      // and it never touches mention/manual_share/owner rows. It also
      // (re-)ensures an 'owner' row exists for every doc with
      // ownerUserId so a future repair can rely on the invariant.
      try {
        const [hygieneFlagRows] = await sequelize.query(
          `SELECT flag FROM system_flags WHERE flag = 'docs_personal_phase2_owner_hygiene_v1'`
        );
        if (hygieneFlagRows.length === 0) {
          const hygieneCounts = { ownerUserIdBackfill: 0, ownerRowsEnsured: 0, staleLegacyForOwnerRemoved: 0 };
          // 1. ownerUserId â† createdBy for any rows that still slipped through.
          const [, h1] = await sequelize.query(`
            UPDATE docs SET "ownerUserId" = "createdBy"
            WHERE "ownerUserId" IS NULL AND "createdBy" IS NOT NULL
          `);
          hygieneCounts.ownerUserIdBackfill = h1?.rowCount ?? 0;
          // 2. Ensure every doc with ownerUserId has an owner row.
          const [, h2] = await sequelize.query(`
            INSERT INTO doc_access ("docId", "userId", "accessLevel", source)
            SELECT id, "ownerUserId", 'owner', 'owner' FROM docs
            WHERE "ownerUserId" IS NOT NULL
            ON CONFLICT ("docId", "userId") DO NOTHING
          `);
          hygieneCounts.ownerRowsEnsured = h2?.rowCount ?? 0;
          // 3. Remove legacy_workspace rows for the doc's owner â€” they're
          //    shadowed by the owner row anyway and confuse the Share panel.
          //    Owner-row, mention rows, manual_share rows are left intact.
          const [, h3] = await sequelize.query(`
            DELETE FROM doc_access da
            USING docs d
            WHERE da."docId" = d.id
              AND d."ownerUserId" IS NOT NULL
              AND da."userId" = d."ownerUserId"
              AND da.source = 'legacy_workspace'
          `);
          hygieneCounts.staleLegacyForOwnerRemoved = h3?.rowCount ?? 0;
          await sequelize.query(
            `INSERT INTO system_flags (flag, completed_at, details)
             VALUES ('docs_personal_phase2_owner_hygiene_v1', NOW(), $1)
             ON CONFLICT (flag) DO NOTHING`,
            { bind: [JSON.stringify(hygieneCounts)] }
          );
          console.log('[Server] docs owner-row hygiene complete:', hygieneCounts);
        }
      } catch (e) {
        console.warn('[Server] docs owner-row hygiene warning:', e.message?.slice(0, 200));
      }
    } catch (e) {
      console.warn('[Server] docs personal-phase2 migration warning:', e.message?.slice(0, 200));
    }

    // â”€â”€ Auto-migration: workflows + workflow_nodes + workflow_edges +
    //    workflow_runs (Workflow Canvas Phase W1). Mirrors the docs
    //    block above â€” CREATE TABLE IF NOT EXISTS is the source of
    //    truth at boot. Coexists with the legacy `automations` table.
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS workflows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(200) NOT NULL,
        description TEXT,
        "boardId" UUID REFERENCES boards(id) ON DELETE CASCADE,
        "workspaceId" UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        "createdBy" UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT false,
        "lastRunAt" TIMESTAMP WITH TIME ZONE,
        "lastRunStatus" VARCHAR(20),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflows_workspace
        ON workflows("workspaceId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflows_board
        ON workflows("boardId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflows_board_active
        ON workflows("boardId", "isActive")`);
      // May-17 audit follow-up â€” optimal index for the hot-path
      // processWorkflows() query: `WHERE isActive=true AND (boardId IS NULL
      // OR boardId=?)`. The (isActive, boardId) column order lets Postgres
      // jump straight to the small `isActive=true` slice first, then scan
      // by boardId within it. The `(boardId, isActive)` index above stays
      // for the inverse access pattern (look up "what's active on this
      // board" without the global filter). Both are tiny.
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflows_active_board
        ON workflows("isActive", "boardId")`);

      await sequelize.query(`CREATE TABLE IF NOT EXISTS workflow_nodes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workflowId" UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        type VARCHAR(16) NOT NULL,
        kind VARCHAR(64) NOT NULL,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        position JSONB NOT NULL DEFAULT '{"x":0,"y":0}'::jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workflow
        ON workflow_nodes("workflowId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workflow_type
        ON workflow_nodes("workflowId", type)`);

      await sequelize.query(`CREATE TABLE IF NOT EXISTS workflow_edges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workflowId" UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        "sourceNodeId" UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
        "targetNodeId" UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
        condition JSONB,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflow_edges_workflow
        ON workflow_edges("workflowId")`);
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_edges_source_target
        ON workflow_edges("sourceNodeId", "targetNodeId")`);
      // Phase W2 â€” branch column for condition-node outgoing edges.
      // 'true' / 'false' / NULL. Idempotent.
      await sequelize.query(`ALTER TABLE workflow_edges
        ADD COLUMN IF NOT EXISTS branch VARCHAR(8)`);

      await sequelize.query(`CREATE TABLE IF NOT EXISTS workflow_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workflowId" UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        trigger VARCHAR(64) NOT NULL,
        context JSONB,
        status VARCHAR(16) NOT NULL,
        "nodesRun" INTEGER NOT NULL DEFAULT 0,
        "durationMs" INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_time
        ON workflow_runs("workflowId", "startedAt" DESC)`);

      // May-19 audit follow-up â€” run-history enrichment. Each column is
      // additive + NULL-safe so a partial replay or a prior hot-patch
      // leaves the table in the same final state. Mirrors migration
      // server/migrations/022_workflows.sql.
      await sequelize.query(`ALTER TABLE workflow_runs
        ADD COLUMN IF NOT EXISTS "finishedAt" TIMESTAMP WITH TIME ZONE`);
      await sequelize.query(`ALTER TABLE workflow_runs
        ADD COLUMN IF NOT EXISTS "actorId" UUID`);
      await sequelize.query(`ALTER TABLE workflow_runs
        ADD COLUMN IF NOT EXISTS "failedStepId" UUID`);
      await sequelize.query(`ALTER TABLE workflow_runs
        ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0`);
      await sequelize.query(`ALTER TABLE workflow_runs
        ADD COLUMN IF NOT EXISTS "idempotencyKey" VARCHAR(255)`);
      await sequelize.query(`ALTER TABLE workflow_runs
        ADD COLUMN IF NOT EXISTS "workflowVersion" INTEGER`);
      // Partial unique â€” only non-NULL keys get the uniqueness guarantee.
      // Matches the idx_notifications_idempotency pattern.
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_idempotency
        ON workflow_runs("workflowId", "idempotencyKey")
        WHERE "idempotencyKey" IS NOT NULL`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_started
        ON workflow_runs("startedAt" DESC)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_actor
        ON workflow_runs("actorId")`);

      // May-19 audit â€” explicit per-FK indexes on workflow_edges for cascade
      // performance on node deletion.
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflow_edges_source
        ON workflow_edges("sourceNodeId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflow_edges_target
        ON workflow_edges("targetNodeId")`);

      // W3 â€” pending wait queue for resumable wait actions (>5 min).
      await sequelize.query(`CREATE TABLE IF NOT EXISTS workflow_waits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workflowId" UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        "fromNodeId" UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
        context JSONB NOT NULL DEFAULT '{}'::jsonb,
        "resumeAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "attemptCount" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflow_waits_resume_at
        ON workflow_waits("resumeAt")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_workflow_waits_workflow
        ON workflow_waits("workflowId")`);

      console.log('[Server] workflows + workflow_nodes + workflow_edges + workflow_runs + workflow_waits tables + indices ensured.');
    } catch (e) {
      console.warn('[Server] workflows migration warning:', e.message?.slice(0, 200));
    }

    // â”€â”€ Auto-migration: forms + form_submissions (Phase F1) â”€â”€
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS forms (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(200) NOT NULL,
        description TEXT,
        slug VARCHAR(80) NOT NULL UNIQUE,
        "workspaceId" UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        "targetBoardId" UUID REFERENCES boards(id) ON DELETE SET NULL,
        fields JSONB NOT NULL DEFAULT '[]'::jsonb,
        "isPublic" BOOLEAN NOT NULL DEFAULT false,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "submissionCount" INTEGER NOT NULL DEFAULT 0,
        "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_forms_workspace
        ON forms("workspaceId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_forms_target_board
        ON forms("targetBoardId")`);
      // Phase F2 â€” targetColumnMap (idempotent). NOT NULL default '{}'::jsonb
      // so the new col is safe to add even when rows already exist.
      await sequelize.query(`ALTER TABLE forms
        ADD COLUMN IF NOT EXISTS "targetColumnMap" JSONB NOT NULL DEFAULT '{}'::jsonb`);

      await sequelize.query(`CREATE TABLE IF NOT EXISTS form_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "formId" UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        "submitterEmail" VARCHAR(320),
        "submitterIp" VARCHAR(64),
        "submitterUserAgent" VARCHAR(500),
        "submittedByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
        "taskId" UUID REFERENCES tasks(id) ON DELETE SET NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_form_submissions_form
        ON form_submissions("formId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_form_submissions_form_time
        ON form_submissions("formId", "createdAt" DESC)`);

      console.log('[Server] forms + form_submissions tables + indices ensured.');
    } catch (e) {
      console.warn('[Server] forms migration warning:', e.message?.slice(0, 200));
    }

    // â”€â”€ Auto-migration: legacy task_labels.id column repair â”€â”€
    //
    // Root cause of the May 12 "null value in column \"id\" of relation
    // \"task_labels\" violates not-null constraint" regression:
    //
    // An earlier revision of server/models/TaskLabel.js declared an `id` UUID
    // primary key. On environments where the Sequelize `sync({ alter: true })`
    // path ran at any point during that window (older dev DBs, the audit
    // workstation), Postgres got a `task_labels.id UUID NOT NULL` column with
    // NO default. The model was later rewritten to use a composite PK
    // (taskId, labelId) â€” see TaskLabel.js comment â€” and the boot DDL above
    // was hardened to match, but `CREATE TABLE IF NOT EXISTS` no-ops on those
    // environments so the legacy `id` column persists. Every INSERT then
    // fails because Sequelize doesn't send `id` and the column has no default.
    //
    // Fix: detect the legacy column, ensure pgcrypto is available, and set
    // DEFAULT gen_random_uuid() so the DB fills the value on insert. We
    // intentionally do NOT drop the column â€” a unique/PK constraint may still
    // reference it, and dropping would risk losing junction rows on databases
    // we cannot inspect from here. Backfilling the default is non-destructive
    // and idempotent: re-running the block is a no-op when the default is
    // already in place.
    try {
      await sequelize.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
      const [legacyIdCols] = await sequelize.query(`
        SELECT column_default, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'task_labels'
        AND column_name = 'id'
      `);
      if (legacyIdCols.length > 0) {
        const hasDefault = !!legacyIdCols[0].column_default;
        if (!hasDefault) {
          await sequelize.query(`ALTER TABLE task_labels ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
          console.log('[Server] task_labels.id legacy column backfilled with DEFAULT gen_random_uuid().');
        } else {
          console.log('[Server] task_labels.id legacy column already has a default â€” no action.');
        }
      }
    } catch (e) {
      console.warn('[Server] task_labels.id legacy repair warning:', e.message?.slice(0, 200));
    }

    // â”€â”€ Auto-migration: task_references and task_links tables â”€â”€
    // Backing storage for the "Reference" and "Link" default columns
    // (multi-value per task). Idempotent CREATE IF NOT EXISTS â€” safe to
    // run on every boot. CASCADE on taskId so archiving a task wipes its
    // associated refs/links; SET NULL on createdBy so deactivating a user
    // doesn't lose history of who added what.
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS task_references (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        text VARCHAR(500) NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_task_references_task_pos ON task_references("taskId", position)`);

      await sequelize.query(`CREATE TABLE IF NOT EXISTS task_links (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        url VARCHAR(2048) NOT NULL,
        title VARCHAR(200),
        position INTEGER NOT NULL DEFAULT 0,
        "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_task_links_task_pos ON task_links("taskId", position)`);
      console.log('[Server] task_references and task_links tables ensured.');
    } catch (e) {
      console.warn('[Server] task_references/task_links migration warning:', e.message?.slice(0, 100));
    }

    // â”€â”€ Auto-migration: backfill default board columns â”€â”€
    // Every board should include the multi-value Reference + Link/URL columns
    // alongside the existing Labels/Progress defaults. Append-only so the
    // user-customised column ORDER and any extra custom columns are
    // preserved. Idempotent â€” appends only when a column of the target
    // TYPE doesn't already exist on the board.
    //
    // Why this is rewritten: the previous version used `sequelize.query()`
    // with a stringified JSONB value, which silently no-op'd on some
    // installs (the UPDATE bound the string but the WHERE matched 0 rows
    // when columns came back differently shaped). Using the Sequelize
    // model + `board.changed('columns', true)` is the canonical pattern in
    // this codebase for JSONB mutation and surfaces failures clearly.
    // P1-1 â€” title normalization is now NON-DESTRUCTIVE: only the literal
    // old default "Link" is rewritten to "Link/URL". Any other user
    // customization (e.g. a user renamed the column to "External Links")
    // is preserved across server restarts. The previous version blindly
    // overwrote every title back to "Link/URL" on each boot.
    //
    // P1-2 â€” the whole pass runs inside a single sequelize.transaction().
    // If any save fails mid-loop, the whole transaction rolls back and
    // the next boot retries from a consistent state.
    try {
      const { Board: BoardModel } = require('./models');
      const DEFAULT_BACKFILL = [
        { id: 'labels',     title: 'Labels',   type: 'label',      width: 160 },
        { id: 'references', title: 'Reference', type: 'references', width: 180 },
        { id: 'links',      title: 'Link/URL', type: 'links',      width: 180 },
      ];

      let backfilledCount = 0;
      let renamedCount = 0;
      const summary = [];

      await sequelize.transaction(async (t) => {
        const boards = await BoardModel.findAll({
          attributes: ['id', 'name', 'columns'],
          transaction: t,
        });
        for (const b of boards) {
          const existing = Array.isArray(b.columns) ? b.columns : [];
          const toAdd = DEFAULT_BACKFILL.filter(c => !existing.some(e => e.type === c.type));

          // Only normalize the literal stale default. Any other custom title
          // is preserved.
          let renamedAny = false;
          const normalized = existing.map((c) => {
            if (c.type === 'links' && c.title === 'Link') { renamedAny = true; return { ...c, title: 'Link/URL' }; }
            if (c.type === 'references' && c.title === 'References') { renamedAny = true; return { ...c, title: 'Reference' }; }
            return c;
          });

          const changed = toAdd.length > 0 || renamedAny;
          if (!changed) continue;

          const next = [...normalized, ...toAdd];
          b.columns = next;
          b.changed('columns', true);
          await b.save({ fields: ['columns'], transaction: t });

          if (toAdd.length > 0) {
            backfilledCount++;
            summary.push(`${b.name || b.id} += [${toAdd.map(c => c.title).join(', ')}]`);
          } else {
            renamedCount++;
          }
        }
      });

      if (backfilledCount > 0) {
        console.log(`[Server] Default-column backfill applied to ${backfilledCount} board(s):`);
        for (const line of summary) console.log(`         Â· ${line}`);
      }
      if (renamedCount > 0) {
        console.log(`[Server] Default-column titles normalized on ${renamedCount} board(s) (Link â†’ Link/URL).`);
      }
      if (backfilledCount === 0 && renamedCount === 0) {
        console.log('[Server] Default-column backfill: all boards already have label/references/links columns with correct titles.');
      }
    } catch (e) {
      // Transaction rolled back â€” log full stack so the failure is
      // recoverable on the next boot without leaving the DB half-migrated.
      console.error('[Server] default columns backfill ERROR (transaction rolled back):', e);
    }

    // â”€â”€ Auto-migration: file_attachments table â”€â”€
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

    // â”€â”€ Auto-migration: add provider & category columns to file_attachments â”€â”€
    // Required by the storage-provider abstraction (007_add_file_attachment_columns.sql).
    // Existing tables created before this migration will be missing these columns.
    try {
      await sequelize.query(`ALTER TABLE file_attachments ADD COLUMN IF NOT EXISTS provider VARCHAR(50) NOT NULL DEFAULT 'local'`);
      await sequelize.query(`ALTER TABLE file_attachments ADD COLUMN IF NOT EXISTS category VARCHAR(50) NOT NULL DEFAULT 'task_attachment'`);
      console.log('[Server] file_attachments provider/category columns ensured.');
    } catch (e) {
      console.warn('[Server] file_attachments column migration warning:', e.message?.slice(0, 100));
    }

    // â”€â”€ Auto-migration: webhooks + webhook_deliveries â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ Auto-migration: transcription_providers + transcript_segments â”€â”€
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

    // â”€â”€ Auto-migration: Task calendar-sync columns (migration 010) â”€â”€
    // Mirrors server/migrations/010_add_task_calendar_sync_fields.sql.
    // Originally applied via server/migrations/run_010.js, but deploy.yml
    // never invokes that script â€” so prod DBs deployed before commit
    // 0a90125 are missing these columns, and `Task.findAll` (which selects
    // all model-declared columns by default) crashes with
    // `column tasks."syncStatus" does not exist`. That single failure takes
    // down GET /api/boards/:id (eager-loads tasks) and GET /api/tasks at
    // the same time â€” i.e. the production board page exactly. Idempotent:
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

    // â”€â”€ Auto-migration: Daily Work / Recurring Task workflow schema â”€â”€
    // Mirrors server/scripts/create-recurring-task-templates.js +
    // server/scripts/add-recurring-fields-to-tasks.js so the schema is
    // self-installing on every boot. Without this, existing prod DBs that
    // pre-date this feature stay stuck on the old schema (sequelize.sync
    // with alter:false creates missing tables but NEVER adds missing
    // columns to existing tables) â€” and every Task.findAll on the new
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
      // Defensive constraints (idempotent via NOT EXISTS via DO block â€” old DBs
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
      // Multi-day monthly support â€” adds an array column alongside the legacy
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
      // Duplicate-protection guarantee â€” partial unique index, only kicks in
      // for recurring instances. Non-recurring tasks unaffected.
      await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS tasks_recurring_template_occurrence_unique
        ON tasks ("recurringTemplateId", "occurrenceDate")
        WHERE "recurringTemplateId" IS NOT NULL AND "occurrenceDate" IS NOT NULL`);

      // Idempotent backfill â€” give legacy done-tasks a completedAt so
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

    // â”€â”€ Auto-migration: Dependency Request system (migration 012) â”€â”€
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
      // Phase 13 â€” back-pointer to the materialized "shadow" Task on the
      // assignee's board. Idempotency key for materialization (controller
      // refuses to create a second Task once this column is non-null).
      // SET NULL on Task delete so the dep row survives even if the surface
      // task is removed independently.
      `ALTER TABLE dependency_requests
         ADD COLUMN IF NOT EXISTS "linkedTaskId" UUID NULL
         REFERENCES tasks(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS dep_req_linked_task_idx
         ON dependency_requests ("linkedTaskId")
         WHERE "linkedTaskId" IS NOT NULL`,
    ]) {
      try {
        await sequelize.query(stmt);
      } catch (e) {
        console.warn('[Server] dependency_requests migration warning:', e.message?.slice(0, 200));
      }
    }
    console.log('[Server] dependency_requests table ensured.');

    // â”€â”€ Auto-migration: extend notifications.type enum for dependency events â”€â”€
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

    // â”€â”€ Auto-migration: Subtask inline-table columns â”€â”€
    // Inline subtasks render in the board grid with the same column set as
    // main tasks (priority, progress, due date, description). The Subtask
    // model declares these but `sequelize.sync({ alter: false })` only
    // creates missing tables â€” it never adds missing columns to an existing
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

    // â”€â”€ Auto-migration: system_settings table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Generic key/value store for platform-wide settings (e.g. inactivity
    // auto-logout duration). Created here explicitly so the table exists
    // independent of sequelize.sync timing, and so the row for inactivity
    // timeout is seeded with the historical 5-minute default â€” preserving
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

    // Sync models â€” create missing tables only, skip ALTER (Sequelize ALTER has bugs with REFERENCES)
    try {
      await sequelize.sync({ alter: false });
      console.log('[Server] Database models synced.');
    } catch (syncErr) {
      console.warn('[Server] DB sync warning (non-fatal):', syncErr.message?.slice(0, 100));
      console.log('[Server] Continuing with existing schema...');
    }

    // â”€â”€ Auto-migration: Add autoAdded column to BoardMembers â”€â”€
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

        // 4. Remove stale auto-added rows where member has no active tasks.
        //    Gated behind a system_flags one-shot flag (P1-29): this destructive
        //    DELETE must run exactly once per deploy. Subsequent boots short-circuit
        //    via a single SELECT against system_flags.
        await sequelize.query(`
          CREATE TABLE IF NOT EXISTS system_flags (
            flag VARCHAR(100) PRIMARY KEY,
            completed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            details JSONB DEFAULT '{}'
          )
        `);
        const [flagRows] = await sequelize.query(
          `SELECT flag FROM system_flags WHERE flag = 'boardmembers_cleanup_v1'`
        );
        if (flagRows.length === 0) {
          const [, cleanMeta] = await sequelize.query(`
            DELETE FROM "BoardMembers" bm
            WHERE bm."autoAdded" = true
              AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t."boardId" = bm."boardId" AND t."assignedTo" = bm."userId" AND (t."isArchived" = false OR t."isArchived" IS NULL))
              AND NOT EXISTS (SELECT 1 FROM task_assignees ta JOIN tasks t ON t.id = ta."taskId" WHERE t."boardId" = bm."boardId" AND ta."userId" = bm."userId" AND (t."isArchived" = false OR t."isArchived" IS NULL))
              AND NOT EXISTS (SELECT 1 FROM task_owners to2 JOIN tasks t ON t.id = to2."taskId" WHERE t."boardId" = bm."boardId" AND to2."userId" = bm."userId" AND (t."isArchived" = false OR t."isArchived" IS NULL))
          `);
          const cleaned = cleanMeta?.rowCount ?? 0;
          if (cleaned > 0) console.log(`[Server] Cleaned ${cleaned} stale auto-added BoardMembers rows.`);
          await sequelize.query(
            `INSERT INTO system_flags (flag, completed_at, details)
             VALUES ('boardmembers_cleanup_v1', NOW(), $1)
             ON CONFLICT (flag) DO NOTHING`,
            { bind: [JSON.stringify({ cleaned })] }
          );
          console.log('[Server] BoardMembers cleanup v1 marked complete in system_flags.');
        }
      }
    } catch (e) {
      console.warn('[Server] BoardMembers autoAdded migration warning:', e.message?.slice(0, 100));
    }

    // â”€â”€ Data backfill: progress=100 for tasks already marked done â”€â”€
    // Idempotent â€” only touches rows that are out-of-sync with the new
    // "completed â‡’ progress 100" invariant enforced by the controller.
    try {
      const [, meta] = await sequelize.query(
        `UPDATE tasks SET progress = 100 WHERE status = 'done' AND (progress IS NULL OR progress < 100)`
      );
      const updated = meta?.rowCount ?? 0;
      if (updated > 0) console.log(`[Server] Backfilled progress=100 on ${updated} done tasks.`);
    } catch (e) {
      console.warn('[Server] Done-task progress backfill warning:', e.message?.slice(0, 100));
    }

    // â”€â”€ Auto-migration: Add lang column to notes table â”€â”€
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
        console.log('[Server] notes table does not exist yet â€” lang column will be created with table.');
      }
    } catch (e) {
      console.warn('[Server] notes.lang migration warning:', e.message?.slice(0, 100));
    }

    // â”€â”€ Auto-migration: Add archivedGroups column to boards table â”€â”€
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

    // â”€â”€ One-shot backfill: mappedStatus on existing Board.groups â”€â”€
    // Boards created before the statusâ†”group mapping feature have groups
    // shaped { id, title, color, position } with no mappedStatus. Without
    // mappedStatus, the auto-move on status change (taskController.updateTask)
    // falls back to id/title-regex matching, which silently no-ops for boards
    // whose group titles were renamed to anything domain-specific. Result:
    // tasks don't move to the matching group when their status changes.
    //
    // This block runs once per environment (gated by system_flags) and infers
    // a mappedStatus for groups whose id or title clearly maps to a known
    // status. Groups whose titles don't match any status are LEFT alone â€” that
    // is the intended freeform-bucket behavior (Sprint 1, Backlog Q3, etc.).
    //
    // Idempotent: groups that already have a mappedStatus are not touched.
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS system_flags (
          flag VARCHAR(100) PRIMARY KEY,
          completed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          details JSONB DEFAULT '{}'
        )
      `);
      const [mappedFlagRows] = await sequelize.query(
        `SELECT flag FROM system_flags WHERE flag = 'group_mapped_status_backfill_v1'`
      );
      if (mappedFlagRows.length === 0) {
        const Board = require('./models/Board');
        // Inverse of STATUS_GROUP_MAP â€” more specific first so "stuck" doesn't
        // fall through to "in_progress".
        const TITLE_TO_STATUS = [
          { pattern: /done|complet|finish|closed/i,                          status: 'done' },
          { pattern: /stuck|block/i,                                         status: 'stuck' },
          { pattern: /review|qa|test|verify/i,                               status: 'review' },
          { pattern: /progress|working|active|doing|started/i,               status: 'working_on_it' },
          { pattern: /to.?do|not.?started|new|backlog|pending|todo|ready/i,  status: 'not_started' },
        ];
        const ID_TO_STATUS = {
          not_started: 'not_started', new: 'not_started',
          working_on_it: 'working_on_it', in_progress: 'working_on_it',
          stuck: 'stuck', review: 'review',
          done: 'done', completed: 'done', closed: 'done',
        };
        const inferStatus = (g) => {
          if (!g || typeof g !== 'object') return null;
          const id = String(g.id || '').toLowerCase().trim();
          if (ID_TO_STATUS[id]) return ID_TO_STATUS[id];
          const title = String(g.title || g.name || '');
          for (const { pattern, status } of TITLE_TO_STATUS) {
            if (pattern.test(title)) return status;
          }
          return null;
        };

        const boards = await Board.findAll({ attributes: ['id', 'groups'] });
        let touchedBoards = 0;
        let touchedGroups = 0;
        for (const board of boards) {
          if (!Array.isArray(board.groups) || board.groups.length === 0) continue;
          let changed = false;
          const next = board.groups.map((g) => {
            if (g && g.mappedStatus) return g;
            const inferred = inferStatus(g);
            if (!inferred) return g;
            changed = true;
            touchedGroups++;
            return { ...g, mappedStatus: inferred };
          });
          if (!changed) continue;
          board.groups = next;
          board.changed('groups', true);
          await board.save();
          touchedBoards++;
        }
        await sequelize.query(
          `INSERT INTO system_flags (flag, completed_at, details)
           VALUES ('group_mapped_status_backfill_v1', NOW(), $1)
           ON CONFLICT (flag) DO NOTHING`,
          { bind: [JSON.stringify({ touchedBoards, touchedGroups })] }
        );
        console.log(`[Server] group_mapped_status backfill v1 complete (boards=${touchedBoards}, groups=${touchedGroups}).`);
      }
    } catch (e) {
      console.warn('[Server] group_mapped_status backfill warning:', e.message?.slice(0, 100));
    }

    // â”€â”€ Auto-migration: Add local_status_override column to users â”€â”€
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

    // â”€â”€ Auto-migration: Add font_size_preference column to users â”€â”€
    // Mirrors server/migrations/013_add_user_font_size_preference.sql so a
    // fresh boot picks up the column without an out-of-band migration step.
    // Idempotent ADD COLUMN IF NOT EXISTS + DO $$ guard for the CHECK
    // constraint â€” safe to re-run.
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

    // â”€â”€ Auto-migration: Add language column to users (migration 016) â”€â”€
    // Mirrors server/migrations/016_add_user_language.sql. Self-installing
    // so production deploys (which only restart the container, never invoke
    // run_016.js) get the column and CHECK constraint on every boot.
    // Idempotent: ADD COLUMN IF NOT EXISTS + DO $$ guard for the constraint.
    try {
      const [userTablesLang] = await sequelize.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`
      );
      if (userTablesLang.length > 0) {
        await sequelize.query(
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS language VARCHAR(8) DEFAULT NULL`
        );
        await sequelize.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'users_language_check'
            ) THEN
              ALTER TABLE users
                ADD CONSTRAINT users_language_check
                CHECK (language IS NULL OR language IN ('en','hi'));
            END IF;
          END $$;
        `);
        console.log('[Server] users.language column ensured.');
      }
    } catch (e) {
      console.warn('[Server] users.language migration warning:', e.message?.slice(0, 100));
    }

    // â”€â”€ Auto-migration: Add tier column to users (migration 014) â”€â”€
    // Mirrors server/migrations/014_add_user_tier.sql. Self-installing so
    // production deploys (which only restart the container, never invoke
    // run_014.js) get the column, the CHECK constraint, the index, and the
    // legacyâ†’tier backfill on every boot. Without this block sequelize.sync
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
        // Backfill from legacy fields. Idempotent â€” re-running re-derives the
        // same value from (isSuperAdmin, role) so concurrent boots are safe.
        // WHERE-guard ensures re-runs against an already-backfilled table touch
        // zero rows (no useless writes, no needless WAL/replication traffic).
        await sequelize.query(`
          UPDATE users SET tier = CASE
            WHEN "isSuperAdmin" = true        THEN 1
            WHEN role IN ('admin','manager')  THEN 2
            WHEN role = 'assistant_manager'   THEN 3
            ELSE                                   4
          END
          WHERE tier IS NULL OR tier <> CASE
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

    // â”€â”€ Auto-migration: hierarchy integrity constraints (migration 015) â”€â”€
    // Mirrors server/migrations/015_hierarchy_constraints.sql. Self-installing
    // for the same reason as 014 â€” production deploys never invoke run_*.js
    // scripts directly. Idempotent: NOT EXISTS guard for the constraint,
    // CREATE INDEX IF NOT EXISTS for the indexes. NOT VALID + VALIDATE
    // pattern means legacy self-referencing rows surface as a clear notice
    // (see migration file) rather than a silent skip.
    try {
      const [userTablesHier] = await sequelize.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`
      );
      if (userTablesHier.length > 0) {
        await sequelize.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'users_no_self_manager'
            ) THEN
              ALTER TABLE users
                ADD CONSTRAINT users_no_self_manager
                CHECK ("managerId" IS NULL OR "managerId" <> id) NOT VALID;
              BEGIN
                ALTER TABLE users VALIDATE CONSTRAINT users_no_self_manager;
              EXCEPTION WHEN check_violation THEN
                RAISE NOTICE 'users_no_self_manager VALIDATE failed â€” clear self-referencing rows.';
              END;
            END IF;
          END $$;
        `);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_users_manager_id ON users("managerId")`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_users_is_active ON users("isActive")`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`);
        console.log('[Server] hierarchy constraint + indexes ensured (mig 015).');
      }
    } catch (e) {
      console.warn('[Server] hierarchy constraints migration warning:', e.message?.slice(0, 100));
    }

    // â”€â”€ Auto-migration: refresh_tokens table (D-2 â€” token rotation/denylist).
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

    // â”€â”€ Auto-migration: backup_records â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Tier-1 DB backup catalog. Created via raw DDL (rather than relying on
    // sequelize.sync) so the column types are stable across deploys and don't
    // depend on Sequelize's ENUM creation order. trigger / status are stored
    // as TEXT with CHECK constraints â€” same shape as the model ENUMs, but
    // avoids the failure mode where a typo in the Sequelize ENUM definition
    // silently writes a string the DB later rejects.
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS backup_records (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          filename        VARCHAR(255) NOT NULL UNIQUE,
          path            VARCHAR(1024) NOT NULL,
          "sizeBytes"     BIGINT,
          trigger         TEXT NOT NULL DEFAULT 'manual'
                          CHECK (trigger IN ('scheduled','manual','pre_restore','uploaded')),
          status          TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','completed','failed')),
          "errorMessage"  TEXT,
          "createdBy"     UUID REFERENCES users(id) ON DELETE SET NULL,
          "completedAt"   TIMESTAMP WITH TIME ZONE,
          "restoredAt"    TIMESTAMP WITH TIME ZONE,
          "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          "updatedAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_backup_records_created_at ON backup_records("createdAt" DESC)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_backup_records_trigger ON backup_records(trigger)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_backup_records_status ON backup_records(status)`);
      // progressPercent added in the in-flight backup progress feature.
      // Existing rows back-fill to 100 when completed / 0 otherwise so the
      // UI doesn't render a stalled-at-0% bar against historical successes.
      await sequelize.query(`ALTER TABLE backup_records
        ADD COLUMN IF NOT EXISTS "progressPercent" INTEGER NOT NULL DEFAULT 0
        CHECK ("progressPercent" >= 0 AND "progressPercent" <= 100)`);
      await sequelize.query(`UPDATE backup_records
        SET "progressPercent" = 100
        WHERE status = 'completed' AND "progressPercent" = 0`);
      console.log('[Server] backup_records table ensured.');
    } catch (e) {
      console.warn('[Server] backup_records migration warning:', e.message?.slice(0, 200));
    }

    // ── Auto-migration: file_backup_records ──────────────────────
    // Catalog for uploaded-FILES backups (tar.gz of the uploads/ dir).
    // A SEPARATE table from backup_records so the files-backup subsystem
    // never shares state with the database-dump subsystem. Same raw-DDL +
    // CHECK-constraint shape as backup_records for the same stability reasons.
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS file_backup_records (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          filename        VARCHAR(255) NOT NULL UNIQUE,
          path            VARCHAR(1024) NOT NULL,
          "sizeBytes"     BIGINT,
          trigger         TEXT NOT NULL DEFAULT 'manual'
                          CHECK (trigger IN ('scheduled','manual','pre_restore','uploaded')),
          status          TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','completed','failed')),
          "errorMessage"  TEXT,
          "createdBy"     UUID REFERENCES users(id) ON DELETE SET NULL,
          "completedAt"   TIMESTAMP WITH TIME ZONE,
          "restoredAt"    TIMESTAMP WITH TIME ZONE,
          "progressPercent" INTEGER NOT NULL DEFAULT 0
                          CHECK ("progressPercent" >= 0 AND "progressPercent" <= 100),
          "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          "updatedAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_file_backup_records_created_at ON file_backup_records("createdAt" DESC)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_file_backup_records_trigger ON file_backup_records(trigger)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_file_backup_records_status ON file_backup_records(status)`);
      console.log('[Server] file_backup_records table ensured.');
    } catch (e) {
      console.warn('[Server] file_backup_records migration warning:', e.message?.slice(0, 200));
    }

    // â”€â”€ Auto-migration: Add receipt columns to task_assignees â”€â”€
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

    // Bootstrap a default AIProvider from env vars (DEEPSEEK_API_KEY /
    // OPENAI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY) when the
    // table is otherwise empty. Idempotent â€” never overwrites an existing
    // active provider configured via /admin-settings. Lets a fresh install
    // boot with summarize/Sidekick working out of the box if any of these
    // vars is set in .env.
    try {
      const { bootstrapFromEnv } = require('./services/aiService');
      bootstrapFromEnv();
    } catch (bootErr) {
      console.warn('[Server] AI env bootstrap skipped:', bootErr.message?.slice(0, 80));
    }

    // â”€â”€ One-time data cleanup: Director Plan & Time Plan â”€â”€
    // One-shot cleanup ran historically. Now invoked manually via
    // `node cleanup-plan-data.js` if needed. See P1-27 in audit.
    // The module is still on disk (and still exports runStartupCleanup) so
    // ops can re-import it from a REPL or script if a future cleanup is needed.
    // try {
    //   const { runStartupCleanup } = require('./cleanup-plan-data');
    //   await runStartupCleanup(sequelize);
    // } catch (cleanupErr) {
    //   console.warn('[Server] Plan data cleanup skipped:', cleanupErr.message?.slice(0, 100));
    // }

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

      // Start Time Planner reminder job (every minute)
      const { startTimePlannerReminderJob } = require('./jobs/timePlannerReminderJob');
      startTimePlannerReminderJob();

      // Start priority escalation job (daily at midnight)
      const { startPriorityEscalationJob } = require('./jobs/priorityEscalationJob');
      startPriorityEscalationJob();

      // Start Microsoft calendar sync retry job (every 15 min)
      const { startCalendarSyncRetryJob } = require('./jobs/calendarSyncRetryJob');
      startCalendarSyncRetryJob();

      // â”€â”€â”€ Daily Work / Recurring Work jobs (Phase B) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Distinct from the legacy `recurringTaskJob` (Task.recurrence JSONB)
      // which still runs at :15. These two jobs drive the new
      // RecurringTaskTemplate + generated-instance design.
      const { startRecurringTemplateGenerationJob } = require('./jobs/recurringTemplateGenerationJob');
      startRecurringTemplateGenerationJob();

      const { startMissedRecurringTaskJob } = require('./jobs/missedRecurringTaskJob');
      startMissedRecurringTaskJob();

      // Outbound webhook retry job (every 5 min) â€” drains failed deliveries
      const { startWebhookRetryJob } = require('./jobs/webhookRetryJob');
      startWebhookRetryJob();

      // Workflow wait resume job (every 1 min) â€” Phase W3. Picks up
      // long-running `wait` actions that were persisted to workflow_waits
      // and resumes the walk past them once their resumeAt has elapsed.
      const { startWorkflowWaitJob } = require('./jobs/workflowWaitJob');
      startWorkflowWaitJob();

      // Weekly VACUUM ANALYZE on hot tables. Defends against the planner-stats
      // drift class of incident (May 2026 pg_toast_2619 corruption hit prod
      // because autovacuum thresholds were too lax for our churn rate). The
      // job is replica-safe via a Postgres advisory lock â€” see jobs/cronLock.js.
      const { startVacuumAnalyzeJob } = require('./jobs/vacuumAnalyzeJob');
      startVacuumAnalyzeJob();

      // Daily DB backup at 18:00 server time (overridable via DB_BACKUP_CRON).
      // Replica-safe via withCronLock; retention runs only after a successful
      // dump. Disable via DB_BACKUP_ENABLED=false if ever needed (the env
      // override is intentionally undocumented in CLAUDE.md so it's not the
      // default escape hatch).
      const { startDailyBackupJob } = require('./jobs/dailyBackupJob');
      startDailyBackupJob();

      // Daily uploaded-FILES backup at 18:30 (overridable via FILE_BACKUP_CRON).
      // Independent of the DB backup above: separate cron lock, separate
      // table (file_backup_records), separate retention. Archives the
      // uploads/ directory as .tar.gz so a DB restore isn't left with
      // dangling attachment rows. Disable via FILE_BACKUP_ENABLED=false.
      const { startDailyFileBackupJob } = require('./jobs/dailyFileBackupJob');
      startDailyFileBackupJob();
    });
  } catch (error) {
    console.error('[Server] Failed to start:', error);
    // Try to start the HTTP server anyway so health checks can report status
    try {
      server.listen(PORT, () => {
        console.error(`[Server] Started on port ${PORT} with errors â€” check logs above`);
      });
    } catch (listenErr) {
      console.error('[Server] Cannot start HTTP server:', listenErr);
      process.exit(1);
    }
  }
};

// Global handlers to prevent silent crashes in production. Routed through
// safeLogger so any Axios/JWT-shaped tokens that show up in the reason
// (e.g. an unhandled rejection from an outbound HTTP call) are scrubbed
// before they hit the log file.
const _safeLogger = require('./utils/safeLogger');
process.on('unhandledRejection', (reason) => {
  _safeLogger.error('[Server] Unhandled Promise Rejection', { reason });
});
process.on('uncaughtException', (err) => {
  _safeLogger.error('[Server] Uncaught Exception', { err });
});

// Graceful shutdown on SIGTERM/SIGINT â€” closes the HTTP server (so in-flight
// requests can finish) then ends the Sequelize pool. Docker compose sends
// SIGTERM then escalates to SIGKILL after ~10s, so we hard-exit at 15s to
// give a small buffer; .unref() so the timer itself can't keep the loop alive.
const gracefulShutdown = (signal) => {
  console.log(`[Server] ${signal} received â€” shutting down gracefully.`);
  server.close((err) => {
    if (err) { console.error('[Server] Error during shutdown:', err); process.exit(1); }
    sequelize.close().finally(() => process.exit(0));
  });
  setTimeout(() => { console.error('[Server] Forcing exit after 15s timeout'); process.exit(1); }, 15000).unref();
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

start();

module.exports = { app, server };
