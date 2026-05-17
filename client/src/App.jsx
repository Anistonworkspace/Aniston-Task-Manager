import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/layout/Layout';
import ErrorBoundary from './components/common/ErrorBoundary';
import AccessDenied from './components/common/AccessDenied';
import AnistonLoader, { AnistonFullScreenLoader } from './components/common/AnistonLoader';
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
// /cross-team URL serves the Dependency Requests page.
const DependenciesPage = lazy(() => import('./pages/DependenciesPage'));
const TasksPage = lazy(() => import('./pages/TasksPage'));
const NotesPage = lazy(() => import('./pages/NotesPage'));
const FeedbackPage = lazy(() => import('./pages/FeedbackPage'));
const RecurringWorkPage = lazy(() => import('./pages/RecurringWorkPage'));
// Phase 1 (Monday-style chrome): workspace landing surface — Recents / Content /
// Permissions tabs anchored at /workspaces/:id. Lives alongside boards; clicking
// a board still navigates to /boards/:id as before.
const WorkspacePage = lazy(() => import('./pages/Workspace/WorkspacePage'));
// Phase 3 (AI Sidekick rearchitect): standalone /sidekick page. The in-app
// SidekickPanel (right-side drawer) is mounted at the Layout level; this
// page is the full-screen variant.
const SidekickPage = lazy(() => import('./pages/Sidekick/SidekickPage'));
// Phase 4 (AI Notetaker): /notetaker landing + /notetaker/meetings/:id detail.
// The classic /meetings route stays in place so existing bookmarks work.
const NotetakerPage = lazy(() => import('./pages/Notetaker/NotetakerPage'));
const MeetingDetailPage = lazy(() => import('./pages/Notetaker/MeetingDetailPage'));
// Doc Editor Phase B: collaborative documents inside a workspace.
//   /workspaces/:workspaceId/docs           → list (DocsListPage)
//   /workspaces/:workspaceId/docs/:docId    → editor (DocPage)
const DocsListPage = lazy(() => import('./pages/Docs/DocsListPage'));
const DocPage = lazy(() => import('./pages/Docs/DocPage'));
// Phase W1 — Workflow Canvas. Two routes:
//   /workflows         → library list (WorkflowsListPage)
//   /workflows/:id     → reactflow canvas (WorkflowCanvasPage)
// Both auth-only; finer permission gating arrives in a follow-up slice.
const WorkflowsListPage = lazy(() => import('./pages/Workflows/WorkflowsListPage'));
const WorkflowCanvasPage = lazy(() => import('./pages/Workflows/WorkflowCanvasPage'));
// Phase F1 — Forms. Internal CRUD routes plus a PUBLIC /f/:slug route that
// is intentionally outside the authenticated Layout (mounted separately in
// the routes block below).
const FormsListPage = lazy(() => import('./pages/Forms/FormsListPage'));
const FormBuilderPage = lazy(() => import('./pages/Forms/FormBuilderPage'));
const FormViewPage = lazy(() => import('./pages/Forms/FormViewPage'));
// Dependency Graph (new) — visual DAG of task → task dependencies. Sits
// alongside the existing list view at /cross-team. Reuses reactflow.
const DependencyGraphPage = lazy(() => import('./pages/DependencyGraphPage'));
// Tier-agnostic Docs entry. Resolves the caller's first visible workspace
// then redirects; shows a friendly empty state when they belong to none.
// Decouples the sidebar Docs nav-item from the workspace data shape so
// members on day 1 see the entry instead of a missing nav row.
const DocsRedirectPage = lazy(() => import('./pages/Docs/DocsRedirectPage'));

function PageLoader() {
  return <AnistonLoader variant="page" size="lg" />;
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <AnistonFullScreenLoader />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <AnistonFullScreenLoader />;
  if (user) return <Navigate to="/" replace />;
  return children;
}

function ManagerRoute({ children, requiredPermission }) {
  const { user, loading, canManage, isSuperAdmin, granularPermissions } = useAuth();
  if (loading) return <AnistonFullScreenLoader />;
  if (!user) return <Navigate to="/login" replace />;
  // Allow if user has manager+ role OR has a specific granular permission override
  const hasOverride = requiredPermission && granularPermissions?.[requiredPermission];
  if (!canManage && !isSuperAdmin && !hasOverride) return <Navigate to="/" replace />;
  return children;
}

function AdminRoute({ children, requiredPermission }) {
  const { user, loading, isAdmin, isSuperAdmin, granularPermissions } = useAuth();
  if (loading) return <AnistonFullScreenLoader />;
  if (!user) return <Navigate to="/login" replace />;
  // Allow if user is admin OR has a specific granular permission override
  const hasOverride = requiredPermission && granularPermissions?.[requiredPermission];
  if (!isAdmin && !isSuperAdmin && !hasOverride) return <Navigate to="/" replace />;
  return children;
}

function StrictAdminRoute({ children, requiredPermission }) {
  const { user, loading, isStrictAdmin, isSuperAdmin, granularPermissions } = useAuth();
  if (loading) return <AnistonFullScreenLoader />;
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
  if (loading) return <AnistonFullScreenLoader />;
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
        {/* Forms (Phase F1) — PUBLIC submit page. Mounted at the top level
            on purpose: the visitor may be unauthenticated and we never want
            them to bounce through /login when they have the public URL. */}
        <Route path="/f/:slug" element={<Suspense fallback={<PageLoader />}><FormViewPage /></Suspense>} />
        <Route path="/" element={<ProtectedRoute><ErrorBoundary><Layout /></ErrorBoundary></ProtectedRoute>}>
          <Route index element={<Suspense fallback={<PageLoader />}><HomePage /></Suspense>} />
          <Route path="my-work" element={<Suspense fallback={<PageLoader />}><MyWorkPage /></Suspense>} />
          <Route path="boards" element={<Suspense fallback={<PageLoader />}><BoardsPage /></Suspense>} />
          <Route path="boards/:id" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><BoardPage /></Suspense></ErrorBoundary>} />
          {/* Workspace landing (Phase 1). Any authenticated user can visit;
              the page itself enforces "owner-only" gating on edit actions. */}
          <Route path="workspaces/:id" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><WorkspacePage /></Suspense></ErrorBoundary>} />
          {/* AI Sidekick standalone page (Phase 3). Two paths: /sidekick (new chat)
              and /sidekick/:chatId (continue an existing local chat). */}
          <Route path="sidekick" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><SidekickPage /></Suspense></ErrorBoundary>} />
          <Route path="sidekick/:chatId" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><SidekickPage /></Suspense></ErrorBoundary>} />
          {/* AI Notetaker (Phase 4). The classic /meetings list is unchanged;
              /notetaker is the Monday-style replacement built on the same
              GET /api/meetings/my data source. */}
          <Route path="notetaker" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><NotetakerPage /></Suspense></ErrorBoundary>} />
          <Route path="notetaker/meetings/:id" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><MeetingDetailPage /></Suspense></ErrorBoundary>} />
          {/* Doc Editor Phase B — collaborative documents. Two routes:
              the workspace list, and a single doc's editor. Both auth-only.
              The top-level `/docs` entry resolves the caller's first
              visible workspace and redirects (or shows an empty state
              when they belong to none). */}
          <Route path="docs" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><DocsRedirectPage /></Suspense></ErrorBoundary>} />
          <Route path="workspaces/:workspaceId/docs" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><DocsListPage /></Suspense></ErrorBoundary>} />
          <Route path="workspaces/:workspaceId/docs/:docId" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><DocPage /></Suspense></ErrorBoundary>} />
          {/* Workflow Canvas (Phase W1) — list + per-workflow canvas. */}
          <Route path="workflows" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><WorkflowsListPage /></Suspense></ErrorBoundary>} />
          <Route path="workflows/:id" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><WorkflowCanvasPage /></Suspense></ErrorBoundary>} />
          {/* Forms (Phase F1) — workspace-scoped list + per-form builder.
              The PUBLIC /f/:slug route is mounted OUTSIDE the Layout below
              so anonymous submitters never bounce through /login. */}
          <Route path="forms" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><FormsListPage /></Suspense></ErrorBoundary>} />
          <Route path="forms/:id" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><FormBuilderPage /></Suspense></ErrorBoundary>} />
          {/* Dependency Graph — visual DAG companion to the /cross-team list. */}
          <Route path="dependencies/graph" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><DependencyGraphPage /></Suspense></ErrorBoundary>} />
          <Route path="boards/:id/dashboard" element={<AdminRoute requiredPermission="dashboard.view"><Suspense fallback={<PageLoader />}><DashboardPage /></Suspense></AdminRoute>} />
          <Route path="dashboard" element={<ManagerRoute requiredPermission="dashboard.view"><Suspense fallback={<PageLoader />}><DashboardPage /></Suspense></ManagerRoute>} />
          {/* Legacy "My Dashboard" routes — folded into the new Dashboard
              (formerly Home) at `/`. The three role-specific paths plus
              `/my-dashboard` and `/home` all redirect home so existing
              bookmarks and deep-links keep working. */}
          <Route path="member-dashboard" element={<Navigate to="/" replace />} />
          <Route path="manager-dashboard" element={<Navigate to="/" replace />} />
          <Route path="admin-dashboard" element={<Navigate to="/" replace />} />
          <Route path="my-dashboard" element={<Navigate to="/" replace />} />
          <Route path="home" element={<Navigate to="/" replace />} />
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
