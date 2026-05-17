import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Loader2 } from 'lucide-react';
import api from '../../services/api';
import safeLog from '../../utils/safeLog';
import EmptyState from '../../components/common/EmptyState';

/**
 * DocsRedirectPage — landing for the top-level `/docs` route.
 *
 * The sidebar's Docs nav item used to deep-link at
 * `/workspaces/<firstWorkspaceId>/docs`, which required the client to
 * already have a workspace list available. Users on tiers 3 / 4 who
 * weren't a member of any workspace yet ended up with no Docs entry at
 * all — there was nothing to point the link at, so the entire Sidebar
 * row was hidden.
 *
 * This page decouples the nav-item from data shape:
 *   - fetches /api/workspaces/mine
 *   - redirects to /workspaces/<first>/docs when there's at least one
 *   - shows a friendly empty state otherwise ("ask your admin to add
 *     you to a workspace to start writing docs")
 *
 * Auth-gated by the parent <Layout>; non-authenticated users never reach here.
 */
export default function DocsRedirectPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [hasWorkspace, setHasWorkspace] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get('/workspaces/mine')
      .then((res) => {
        if (cancelled) return;
        const list =
          res.data?.workspaces
          || res.data?.data?.workspaces
          || res.data?.data
          || res.data
          || [];
        const first = Array.isArray(list) ? list[0] : null;
        if (first?.id) {
          setHasWorkspace(true);
          // `replace: true` so back-button doesn't trap users on /docs.
          navigate(`/workspaces/${first.id}/docs`, { replace: true });
        }
      })
      .catch((err) => safeLog.warn('[DocsRedirectPage] workspaces load failed', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [navigate]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-sm text-text-tertiary">
        <Loader2 size={14} className="animate-spin" /> Loading your docs…
      </div>
    );
  }

  // Redirect already happened in the loading branch when a workspace exists.
  // Reaching here means the user has zero visible workspaces.
  if (hasWorkspace) return null;

  return (
    <div className="p-6">
      <EmptyState
        icon={<BookOpen size={48} className="text-text-tertiary" />}
        title="No workspaces yet"
        description="Docs live inside workspaces. Ask your admin to add you to a workspace, then come back here to start writing."
        primaryAction={{ label: 'Back to home', onClick: () => navigate('/') }}
      />
    </div>
  );
}
