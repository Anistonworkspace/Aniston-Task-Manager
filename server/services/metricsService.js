'use strict';

/**
 * Lightweight in-memory metrics counter for the new label / reference /
 * link surfaces. Designed to be cheap (no external deps), exposable
 * via a future GET /api/metrics endpoint, and forwarded to Prometheus/
 * StatsD when an exporter is added.
 *
 * Counters are integers keyed by event name. Histograms are arrays of
 * latency samples capped at 1024 entries (oldest dropped) so the process
 * memory footprint stays bounded.
 *
 * Why this exists rather than wiring straight to prom-client now:
 *   - prom-client + a /metrics endpoint is one PR away; this layer lets
 *     the controllers start instrumenting today without coupling.
 *   - The /api/metrics endpoint can read snapshot() and serve text/json
 *     to the operator without a new dep.
 *   - Unit tests can reset() between cases and assert counters directly.
 */

const counters = new Map();
const histograms = new Map();
const HISTOGRAM_CAP = 1024;

function increment(name, by = 1, labels = null) {
  const key = labels ? `${name}|${JSON.stringify(labels)}` : name;
  counters.set(key, (counters.get(key) || 0) + by);
}

function observe(name, sample, labels = null) {
  const key = labels ? `${name}|${JSON.stringify(labels)}` : name;
  let arr = histograms.get(key);
  if (!arr) { arr = []; histograms.set(key, arr); }
  arr.push(sample);
  if (arr.length > HISTOGRAM_CAP) arr.shift();
}

/**
 * Wraps an Express controller function so its latency + status are
 * recorded automatically. Usage:
 *   exports.assignLabel = metrics.instrument('labels.assign', async (req, res) => {...});
 *
 * Records:
 *   counter "<name>.requests" — total calls
 *   counter "<name>.errors"   — exceptions thrown
 *   histogram "<name>.latency_ms" — wall-clock duration
 */
function instrument(name, handler) {
  return async function instrumented(req, res, next) {
    const started = Date.now();
    increment(`${name}.requests`);
    try {
      const result = await handler(req, res, next);
      observe(`${name}.latency_ms`, Date.now() - started);
      return result;
    } catch (err) {
      increment(`${name}.errors`);
      observe(`${name}.latency_ms`, Date.now() - started);
      throw err;
    }
  };
}

function snapshot() {
  const out = { counters: {}, histograms: {} };
  for (const [k, v] of counters.entries()) out.counters[k] = v;
  for (const [k, arr] of histograms.entries()) {
    if (arr.length === 0) continue;
    const sorted = [...arr].sort((a, b) => a - b);
    const sum = sorted.reduce((s, n) => s + n, 0);
    out.histograms[k] = {
      count: arr.length,
      min: sorted[0],
      p50: sorted[Math.floor(arr.length * 0.5)],
      p95: sorted[Math.floor(arr.length * 0.95)],
      p99: sorted[Math.floor(arr.length * 0.99)],
      max: sorted[arr.length - 1],
      avg: sum / arr.length,
    };
  }
  return out;
}

function reset() {
  counters.clear();
  histograms.clear();
}

module.exports = { increment, observe, instrument, snapshot, reset };
