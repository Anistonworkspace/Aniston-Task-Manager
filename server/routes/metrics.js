'use strict';

/**
 * GET /api/metrics — admin-only operational snapshot.
 *
 * Returns the in-memory counters + histograms recorded by metricsService.
 * Designed as a stepping stone toward a proper Prometheus/StatsD exporter:
 * an ops engineer can hit this endpoint directly during incident triage
 * to see the abuse-detection counters (cross-board attempts, view-access
 * denials, URL validator rejections, etc.) without standing up a metrics
 * pipeline first.
 */

const express = require('express');
const { authenticate, adminOnly } = require('../middleware/auth');
const metrics = require('../services/metricsService');

const router = express.Router();

router.get('/', authenticate, adminOnly, (_req, res) => {
  res.json({ success: true, data: metrics.snapshot() });
});

module.exports = router;
