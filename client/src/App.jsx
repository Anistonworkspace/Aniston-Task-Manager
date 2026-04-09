import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/layout/Layout';
import ErrorBoundary from './components/common/ErrorBoundary';

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
const CrossTeamTasksPage = lazy(() => import('./pages/CrossTeamTasksPage'));
const TasksPage = lazy(() => import('./pages/TasksPage'));
const MemberDashboardPage = lazy(() => import('./pages/MemberDashboardPage'));
const ManagerDashboardPage = lazy(() => import('./pages/ManagerDashboardPage'));
const AdminDashboardPage = lazy(() => import('./pages/AdminDashboardPage'));
const DirectorDashboardPage = lazy(() => import('./pages/DirectorDashboardPage'));
const AssistantManagerPlanPage = lazy(() => import('./pages/AssistantManagerPlanPage'));
const NotesPage = lazy(() => import('./pages/NotesPage'));
const FeedbackPage = lazy(() => import('./pages/FeedbackPage'));

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

function ManagerRoute({ children }) {
  const { user, loading, canManage, isSuperAdmin } = useAuth();
  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (!canManage && !isSuperAdmin) return <Navigate to="/" replace />;
  return children;
}

function AdminRoute({ children }) {
  const { user, loading, isAdmin } = useAuth();
  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (!isAdmin) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
        <Route path="/forgot-password" element={<PublicRoute><ForgotPassword /></PublicRoute>} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
          <Route index element={<Suspense fallback={<PageLoader />}><HomePage /></Suspense>} />
          <Route path="my-work" element={<Suspense fallback={<PageLoader />}><MyWorkPage /></Suspense>} />
          <Route path="boards" element={<Suspense fallback={<PageLoader />}><BoardsPage /></Suspense>} />
          <Route path="boards/:id" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><BoardPage /></Suspense></ErrorBoundary>} />
          <Route path="boards/:id/dashboard" element={<ManagerRoute><Suspense fallback={<PageLoader />}><DashboardPage /></Suspense></ManagerRoute>} />
          <Route path="dashboard" element={<ManagerRoute><Suspense fallback={<PageLoader />}><DashboardPage /></Suspense></ManagerRoute>} />
          <Route path="member-dashboard" element={<Suspense fallback={<PageLoader />}><MemberDashboardPage /></Suspense>} />
          <Route path="manager-dashboard" element={<ManagerRoute><Suspense fallback={<PageLoader />}><ManagerDashboardPage /></Suspense></ManagerRoute>} />
          <Route path="admin-dashboard" element={<AdminRoute><Suspense fallback={<PageLoader />}><AdminDashboardPage /></Suspense></AdminRoute>} />
          <Route path="director-dashboard" element={<ManagerRoute><ErrorBoundary><Suspense fallback={<PageLoader />}><DirectorDashboardPage /></Suspense></ErrorBoundary></ManagerRoute>} />
          <Route path="director-plan" element={<ManagerRoute><Suspense fallback={<PageLoader />}><AssistantManagerPlanPage /></Suspense></ManagerRoute>} />
          <Route path="timeline" element={<Suspense fallback={<PageLoader />}><TimelinePage /></Suspense>} />
          <Route path="time-plan" element={<Suspense fallback={<PageLoader />}><TimePlanPage /></Suspense>} />
          <Route path="reviews" element={<Suspense fallback={<PageLoader />}><ReviewPage /></Suspense>} />
          <Route path="profile" element={<Suspense fallback={<PageLoader />}><ProfilePage /></Suspense>} />
          <Route path="meetings" element={<Suspense fallback={<PageLoader />}><MeetingsPage /></Suspense>} />
          <Route path="integrations" element={<ManagerRoute><Suspense fallback={<PageLoader />}><IntegrationsPage /></Suspense></ManagerRoute>} />
          <Route path="archive" element={<ManagerRoute><Suspense fallback={<PageLoader />}><ArchivedPage /></Suspense></ManagerRoute>} />
          <Route path="users" element={<ManagerRoute><Suspense fallback={<PageLoader />}><UserManagementPage /></Suspense></ManagerRoute>} />
          <Route path="admin-settings" element={<AdminRoute><ErrorBoundary><Suspense fallback={<PageLoader />}><AdminSettingsPage /></Suspense></ErrorBoundary></AdminRoute>} />
          <Route path="access-requests" element={<ManagerRoute><Suspense fallback={<PageLoader />}><AccessRequestPage /></Suspense></ManagerRoute>} />
          <Route path="org-chart" element={<Suspense fallback={<PageLoader />}><OrgChartPage /></Suspense>} />
          <Route path="cross-team" element={<Suspense fallback={<PageLoader />}><CrossTeamTasksPage /></Suspense>} />
          <Route path="tasks" element={<Suspense fallback={<PageLoader />}><TasksPage /></Suspense>} />
          <Route path="notes" element={<Suspense fallback={<PageLoader />}><NotesPage /></Suspense>} />
          <Route path="feedback" element={<AdminRoute><Suspense fallback={<PageLoader />}><FeedbackPage /></Suspense></AdminRoute>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
