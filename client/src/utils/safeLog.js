// safeLog — production-aware console wrapper.
//
// Why this exists:
//   - In dev, we want full visibility: stack traces, response bodies, the
//     whole Axios error. It helps debugging.
//   - In prod, raw `console.error(err)` on an Axios error dumps the full
//     request config — which on legacy fallback paths can include an
//     Authorization header value. It also fills the browser console with
//     noise that users sometimes screenshot into support tickets.
//
// API mirrors console (debug/info/warn/error). Pass either a string or
// a string + extra args. For errors, the helper pulls out a SAFE subset
// (status, code, requestId, message) and drops the rest.
//
// Production behaviour:
//   - `debug` and `info` → completely silenced.
//   - `warn` and `error` → emit a single line with the safe subset.
//
// Development behaviour:
//   - Everything goes to the real console, unchanged.

const IS_DEV =
  typeof import.meta !== 'undefined' &&
  import.meta &&
  import.meta.env &&
  import.meta.env.DEV === true;

// Heuristic — is this object an Axios error? We avoid importing axios
// here so this util stays tiny and tree-shakeable.
function isAxiosErrorLike(v) {
  return Boolean(v && typeof v === 'object' && (v.isAxiosError === true || v.response || v.request));
}

// Strip an Axios error down to fields safe to log in production. Mirrors
// the philosophy of the server-side safeLogger redactor — keep diagnostic
// fields (status, code, requestId, message), drop the rest (config,
// request, response headers, response data body).
function safeErrorSummary(err) {
  if (err == null) return err;
  if (isAxiosErrorLike(err)) {
    const status = err.response?.status ?? 0;
    const data = err.response?.data;
    const code =
      (data && typeof data?.error?.code === 'string' && data.error.code) ||
      (data && typeof data?.code === 'string' && data.code) ||
      err.code ||
      null;
    const requestId =
      (data && typeof data?.error?.requestId === 'string' && data.error.requestId) ||
      err.response?.headers?.['x-request-id'] ||
      null;
    return { status, code, requestId, message: err.message || null };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return err;
}

// Convert all args to their safe equivalents — Axios errors get summarised,
// other args pass through. Strings are always preserved exactly so the
// label/context developers attach (e.g. "[BoardPage] loadBoard error")
// keeps its meaning.
function mapArgs(args) {
  return args.map((a) => (typeof a === 'string' ? a : safeErrorSummary(a)));
}

function debug(...args) {
  if (!IS_DEV) return;
  // eslint-disable-next-line no-console
  console.debug(...args);
}

function info(...args) {
  if (!IS_DEV) return;
  // eslint-disable-next-line no-console
  console.info(...args);
}

function warn(...args) {
  // eslint-disable-next-line no-console
  console.warn(...(IS_DEV ? args : mapArgs(args)));
}

function error(...args) {
  // eslint-disable-next-line no-console
  console.error(...(IS_DEV ? args : mapArgs(args)));
}

export default { debug, info, warn, error };
export { debug, info, warn, error, safeErrorSummary };
