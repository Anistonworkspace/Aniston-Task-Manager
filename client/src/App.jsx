import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/layout/Layout';
import ErrorBoundary from './components/common/ErrorBoundary';
import AccessDenied from './components/common/AccessDenied';
import { isExplicitlyDenied } from './utils/permissions';
import ProfileModalRoute from './components/profile/ProfileModalRoute';

// Auth pages — loaded eagerly (small, needed immediately)
import Login from './components/auth/Login';
import ForgotPassword from './components/auth/ForgotPassword';
import ResetPassword from './components/auth/ResetPassword';
// Lazy-loaded pages — code-split for smaller initial bundle
const HomePage = lazy(() => import('./pages/HomePage'));
const MyWorkPage = lazy(() => import('./pages/MyWorkPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const BoardsPage = lazy(() => import('./pages/BoardsPage'));
const BoardPage = lazy(() => import('./pages/BoardPage'));
const TimelinePage = lazy(() => import('./pages/TimelinePage'));
const UserManagementPage = lazy(() => import('./pages/UserManagementPage'));
const TimePlanPage = lazy(() => import('./pages/TimePlanPage'));
const ReviewPage = lazy(() => import('./pages/ReviewPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const MeetingsPage = lazy(() => import('./pages/MeetingsPage'));
const IntegrationsPage = lazy(() => import('./pages/IntegrationsPage'));
const ArchivedPage = lazy(() => import('./pages/ArchivedPage'));
const AdminSettingsPage = lazy(() => import('./pages/AdminSettingsPage'));
const AccessRequestPage = lazy(() => import('./pages/AccessRequestPage'));
const OrgChartPage = lazy(() => import('./pages/OrgChartPage'));
// Phase 7: /cross-team URL now serves the new Dependency Requests page. The
// legacy CrossTeamTasksPage file is retained for reference but no longer
// routed — the new DependenciesPage replaces it in place.
const DependenciesPage = lazy(() => import('./pages/DependenciesPage'));
const TasksPage = lazy(() => import('./pages/TasksPage'));
const MemberDashboardPage = lazy(() => import('./pages/MemberDashboardPage'));
const ManagerDashboardPage = lazy(() => import('./pages/ManagerDashboardPage'));
const AdminDashboardPage = lazy(() => import('./pages/AdminDashboardPage'));
const NotesPage = lazy(() => import('./pages/NotesPage'));
const FeedbackPage = lazy(() => import('./pages/FeedbackPage'));
const RecurringWorkPage = lazy(() => import('./pages/RecurringWorkPage'));

function PageLoader() {
  return (
    <div className="h-full w-full flex items-center justify-center py-20">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (user) return <Navigate to="/" replace />;
  return children;
}

function ManagerRoute({ children, requiredPermission }) {
  const { user, loading, canManage, isSuperAdmin, granularPermissions } = useAuth();
  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  // Allow if user has manager+ role OR has a specific granular permission override
  const hasOverride = requiredPermission && granularPermissions?.[requiredPermission];
  if (!canManage && !isSuperAdmin && !hasOverride) return <Navigate to="/" replace />;
  return children;
}

function AdminRoute({ children, requiredPermission }) {
  const { user, loading, isAdmin, isSuperAdmin, granularPermissions } = useAuth();
  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  // Allow if user is admin OR has a specific granular permission override
  const hasOverride = requiredPermission && granularPermissions?.[requiredPermission];
  if (!isAdmin && !isSuperAdmin && !hasOverride) return <Navigate to="/" replace />;
  return children;
}

function StrictAdminRoute({ children, requiredPermission }) {
  const { user, loading, isStrictAdmin, isSuperAdmin, granularPermissions } = useAuth();
  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  // Strict admin only (not manager) — for Admin Settings, Integrations, Feedback
  const hasOverride = requiredPermission && granularPermissions?.[requiredPermission];
  if (!isStrictAdmin && !isSuperAdmin && !hasOverride) return <Navigate to="/" replace />;
  return children;
}

/**
 * PermissionRoute — guards a route that is base-allowed for everyone (e.g.
 * Org Chart view) but can be revoked by an explicit DENY override. Mirrors
 * the server's permission engine: deny precedence wins, role-based defaults
 * and explicit grants both pass through unless the resolver said false.
 *
 * Use this for routes where any authenticated user normally has access, but
 * an admin may have issued a DENY override on the resource/action pair.
 * Accepts `requiredPermission` in "resource.action" format (e.g.
 * "org_chart.view"). Renders <AccessDenied/> instead of redirecting silently
 * so direct-URL hits surface a clean reason.
 */
function PermissionRoute({ children, requiredPermission, resourceLabel = 'this page', action = 'view' }) {
  const { user, loading, isSuperAdmin, granularPermissions } = useAuth();
  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (requiredPermission && !isSuperAdmin) {
    const [resource, act] = requiredPermission.split('.');
    if (isExplicitlyDenied(resource, act, isSuperAdmin, granularPermissions)) {
      return <AccessDenied resourceLabel={resourceLabel} action={action} />;
    }
  }
  return children;
}

export default function App() {
  // ── Modal-route pattern (a la React Router docs) ──────────────────────
  // When a trigger navigates to `/profile` with `state: { background: location }`,
  // we render the existing routes against the BACKGROUND location (so the
  // prior page — board, dashboard, whatever — stays mounted and visible)
  // AND mount the ProfileModalRoute on top. Closing the modal pops history,
  // which restores the URL and unmounts the overlay without ever
  // remounting the background page.
  //
  // On a direct visit / refresh of `/profile`, `state.background` is absent
  // and we render the standard route, which serves the `variant="page"`
  // ProfilePage as a graceful fallback.
  const location = useLocation();
  const background = location.state?.background;

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes location={background || location}>
        <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
        <Route path="/forgot-password" element={<PublicRoute><ForgotPassword /></PublicRoute>} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/" element={<ProtectedRoute><ErrorBoundary><Layout /></ErrorBoundary></ProtectedRoute>}>
          <Route index element={<Suspense fallback={<PageLoader />}><HomePage /></Suspense>} />
          <Route path="my-work" element={<Suspense fallback={<PageLoader />}><MyWorkPage /></Suspense>} />
          <Route path="boards" element={<Suspense fallback={<PageLoader />}><BoardsPage /></Suspense>} />
          <Route path="boards/:id" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><BoardPage /></Suspense></ErrorBoundary>} />
          <Route path="boards/:id/dashboard" element={<AdminRoute requiredPermission="dashboard.view"><Suspense fallback={<PageLoader />}><DashboardPage /></Suspense></AdminRoute>} />
          <Route path="dashboard" element={<ManagerRoute requiredPermission="dashboard.view"><Suspense fallback={<PageLoader />}><DashboardPage /></Suspense></ManagerRoute>} />
          <Route path="member-dashboard" element={<Suspense fallback={<PageLoader />}><MemberDashboardPage /></Suspense>} />
          <Route path="manager-dashboard" element={<AdminRoute requiredPermission="dashboard.view"><Suspense fallback={<PageLoader />}><ManagerDashboardPage /></Suspense></AdminRoute>} />
          <Route path="admin-dashboard" element={<AdminRoute requiredPermission="dashboard.view"><Suspense fallback={<PageLoader />}><AdminDashboardPage /></Suspense></AdminRoute>} />
          {/* Director Dashboard and Director Plan routes removed — modules retired. */}
          <Route path="director-dashboard" element={<Navigate to="/" replace />} />
          <Route path="director-plan" element={<Navigate to="/" replace />} />
          <Route path="timeline" element={<Suspense fallback={<PageLoader />}><TimelinePage /></Suspense>} />
          <Route path="time-plan" element={<Suspense fallback={<PageLoader />}><TimePlanPage /></Suspense>} />
          <Route path="reviews" element={<Suspense fallback={<PageLoader />}><ReviewPage /></Suspense>} />
          <Route path="profile" element={<Suspense fallback={<PageLoader />}><ProfilePage /></Suspense>} />
          <Route path="meetings" element={<Suspense fallback={<PageLoader />}><MeetingsPage /></Suspense>} />
          <Route path="integrations" element={<StrictAdminRoute requiredPermission="integrations.view"><Suspense fallback={<PageLoader />}><IntegrationsPage /></Suspense></StrictAdminRoute>} />
          <Route path="archive" element={<AdminRoute requiredPermission="archive.view"><Suspense fallback={<PageLoader />}><ArchivedPage /></Suspense></AdminRoute>} />
          <Route path="users" element={<AdminRoute requiredPermission="users.view"><Suspense fallback={<PageLoader />}><UserManagementPage /></Suspense></AdminRoute>} />
          <Route path="admin-settings" element={<StrictAdminRoute requiredPermission="admin_settings.view"><ErrorBoundary><Suspense fallback={<PageLoader />}><AdminSettingsPage /></Suspense></ErrorBoundary></StrictAdminRoute>} />
          <Route path="access-requests" element={<AdminRoute requiredPermission="roles.view"><Suspense fallback={<PageLoader />}><AccessRequestPage /></Suspense></AdminRoute>} />
          <Route path="org-chart" element={<PermissionRoute requiredPermission="org_chart.view" resourceLabel="the Org Chart" action="view"><Suspense fallback={<PageLoader />}><OrgChartPage /></Suspense></PermissionRoute>} />
          <Route path="cross-team" element={<Suspense fallback={<PageLoader />}><DependenciesPage /></Suspense>} />
          <Route path="tasks" element={<Suspense fallback={<PageLoader />}><TasksPage /></Suspense>} />
          <Route path="notes" element={<Suspense fallback={<PageLoader />}><NotesPage /></Suspense>} />
          {/* All authenticated users can land here. Server-side filtering hides templates the user
              shouldn't see (members → only their own; assistant managers → subtree). */}
          <Route path="recurring-work" element={<Suspense fallback={<PageLoader />}><RecurringWorkPage /></Suspense>} />
          {/* Feedback: enter with feedback.view (managers + granted members);
              page itself hides manage actions unless feedback.manage holds. */}
          <Route path="feedback" element={<StrictAdminRoute requiredPermission="feedback.view"><Suspense fallback={<PageLoader />}><FeedbackPage /></Suspense></StrictAdminRoute>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Overlay modal routes — only mounted when a navigation supplied
          `state.background`. The Profile route here renders the actual
          DetailModalShell-based overlay on top of whatever page the user
          was viewing when they triggered it. Direct /profile visits do
          NOT carry state.background, so this block is bypassed and the
          regular route above renders the page-variant ProfilePage. */}
      {background && (
        <Routes>
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <ProfileModalRoute />
              </ProtectedRoute>
            }
          />
        </Routes>
      )}
    </Suspense>
  );
}
