import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import safeLog from '../../utils/safeLog';

// ErrorBoundary — catches render-time crashes in a subtree and shows a
// safe fallback instead of a white screen.
//
// Variants:
//   - "page"    (default): full-screen fallback with "Go Home" + "Refresh
//                          Page" actions. Use at the top of the app and
//                          at route boundaries.
//   - "section":           inline fallback that fits inside a card / panel
//                          and offers a subtree-only retry (resets the
//                          boundary's `hasError` flag without reloading
//                          the page). Use around individual widgets
//                          (Calendar, Timeline, TaskModal, etc.) so one
//                          crashing widget doesn't blank the whole page.
//
// Props (all optional):
//   - name:        identifier used in the log line ("TaskModal", "Calendar")
//                  so support can correlate a crash to the area of UI.
//   - variant:     "page" | "section"  (default: "page")
//   - fallback:    custom render function `(state) => ReactNode`. When
//                  supplied, replaces the built-in fallback entirely.
//                  state shape: { error, reset }.
//   - onError:     callback `(error, errorInfo) => void` for instrumenting.
//   - resetKeys:   array; whenever any key changes, the boundary auto-resets.
//                  Use for "navigate to a different task → clear the crash".
//
// Logging notes:
//   - We route through safeLog so production browsers don't dump a full
//     component stack (errorInfo.componentStack) into the console. In dev,
//     full info is preserved.
//   - We never render error.message OR component stacks in production UI —
//     a crash should not leak file paths, line numbers, or internal class
//     names to the end user.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    const name = this.props.name || 'app';
    safeLog.error(`[ErrorBoundary:${name}] render crash`, error);
    // componentStack can be huge and contains file paths — only surface
    // it in dev. safeLog.debug is a no-op in production builds.
    safeLog.debug(`[ErrorBoundary:${name}] component stack`, errorInfo && errorInfo.componentStack);
    if (typeof this.props.onError === 'function') {
      try { this.props.onError(error, errorInfo); } catch { /* swallow */ }
    }
  }

  componentDidUpdate(prevProps) {
    // Auto-reset when the parent signals a reset key change. Useful for
    // wrapping a per-route subtree without manual reset wiring.
    if (!this.state.hasError) return;
    const prev = prevProps.resetKeys;
    const curr = this.props.resetKeys;
    if (!Array.isArray(curr) || !Array.isArray(prev)) return;
    if (curr.length !== prev.length) { this.reset(); return; }
    for (let i = 0; i < curr.length; i += 1) {
      if (!Object.is(curr[i], prev[i])) { this.reset(); return; }
    }
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    this.reset();
    if (typeof window !== 'undefined') window.location.reload();
  };

  handleGoHome = () => {
    this.reset();
    if (typeof window !== 'undefined') window.location.href = '/';
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    // Custom fallback wins — caller knows the surrounding layout best.
    if (typeof this.props.fallback === 'function') {
      try {
        return this.props.fallback({ error: this.state.error, reset: this.reset });
      } catch {
        // If the custom fallback ALSO throws, fall through to the built-in
        // UI so the user still sees something usable.
      }
    }

    const variant = this.props.variant || 'page';
    const isDev = (typeof import.meta !== 'undefined' && import.meta?.env?.DEV === true);
    // Dev-only — production must NEVER show the raw error.toString() since
    // it can include third-party stack frames with file paths.
    const devDetail = isDev && this.state.error ? String(this.state.error) : null;
    const name = this.props.name;

    if (variant === 'section') {
      return (
        <div className="w-full p-6 my-2 bg-surface border border-border rounded-lg">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 bg-red-100 rounded-full flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5 text-red-500" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-text-primary mb-1">
                This section could not be displayed
              </h3>
              <p className="text-xs text-text-secondary mb-3">
                Something went wrong while rendering {name ? <strong className="text-text-primary">{name}</strong> : 'this view'}. The rest of the page is still working.
              </p>
              {devDetail && (
                <pre className="text-[11px] text-left bg-gray-100 p-2 rounded mb-3 overflow-auto max-h-24 text-red-600">
                  {devDetail}
                </pre>
              )}
              <button
                onClick={this.reset}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-primary rounded-md hover:bg-primary/90"
              >
                <RefreshCw size={12} />
                Try again
              </button>
            </div>
          </div>
        </div>
      );
    }

    // "page" variant — full-screen, suits route-level wraps.
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-gray-50">
        <div className="text-center max-w-md mx-auto px-6">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-8 h-8 text-red-500" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h1>
          <p className="text-sm text-gray-500 mb-6">
            An unexpected error occurred. Please try refreshing the page.
          </p>
          {devDetail && (
            <pre className="text-xs text-left bg-gray-100 p-3 rounded-lg mb-4 overflow-auto max-h-32 text-red-600">
              {devDetail}
            </pre>
          )}
          <div className="flex gap-3 justify-center">
            <button
              onClick={this.handleGoHome}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Go Home
            </button>
            <button
              onClick={this.handleReload}
              className="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 flex items-center gap-2"
            >
              <RefreshCw size={14} />
              Refresh Page
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
