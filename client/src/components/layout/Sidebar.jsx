import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Home, User, ChevronDown, ChevronRight, Plus, Search, MoreHorizontal,
  FolderKanban, Star, StarOff, BarChart3, FileText, CalendarDays,
  Puzzle, Archive, Settings, PanelLeftClose, PanelLeft,
  Edit3, ArrowUpDown, LayoutGrid, ClipboardCheck,
  RefreshCw, Pin, PinOff, Sparkles, BookOpen, Workflow,
  Users, Trash2, FileSpreadsheet,
} from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useT } from '../../context/LanguageContext';
import useRealtimeQuery from '../../realtime/useRealtimeQuery';
import CreateWorkspaceModal from '../board/CreateWorkspaceModal';
import CreateBoardModal from '../board/CreateBoardModal';
import RearrangeBoardsModal from '../board/RearrangeBoardsModal';
import RearrangeWorkspacesModal from '../board/RearrangeWorkspacesModal';
import BrowseAllWorkspacesModal from '../workspace/BrowseAllWorkspaces';
import ContextMenu from '../common/ContextMenu/ContextMenu';
// Phase 1 (Monday-style chrome): unified "+ Add new" Popover menu. Wraps
// the existing Create-board + Create-workspace flows and grows naturally
// as future content types (Doc / Dashboard / Form / Workflow) ship.
import AddNewContentMenu from './AddNewContentMenu';
import { canUser } from '../../utils/permissions';
import { resolveTier, tierLabel } from '../../utils/tiers';
import { useApprovalsBadgeCount, formatBadgeCount } from '../../hooks/useNavBadgeCounts';

// Per-user workspace usage memory (client-side only — survives reload, does
// not sync across devices/browsers). Drives the "top 3 workspaces" sort in
// the sidebar so the lists the user actually opens float to the top.
//   { [wsId]: { lastOpenedAt: epochMs, openCount: number, pinned: boolean } }
const WS_USAGE_KEY = 'workspaceUsage';
function readWorkspaceUsage() {
  try { return JSON.parse(localStorage.getItem(WS_USAGE_KEY) || '{}') || {}; }
  catch { return {}; }
}
function writeWorkspaceUsage(obj) {
  try { localStorage.setItem(WS_USAGE_KEY, JSON.stringify(obj)); } catch {}
}
// Recency-weighted ranking. 70% recency (with a 7-day half-life), 30% volume
// — so a workspace opened yesterday outranks one clicked 100 times last
// month. The volume cap prevents a single binge-week from pinning a
// workspace forever.
function workspaceScore(entry) {
  if (!entry) return 0;
  const days = entry.lastOpenedAt ? (Date.now() - entry.lastOpenedAt) / 86400000 : 365;
  const recency = 1 / (1 + days / 7);
  const volume = Math.min(entry.openCount || 0, 50) / 50;
  return recency * 0.7 + volume * 0.3;
}

// Portal-based dropdown that renders outside sidebar overflow
function WorkspaceMenu({ anchorRef, open, onClose, onNavigate, onAddWorkspace, onRearrangeWorkspaces, onBrowseAllWorkspaces, canCreateWorkspace, canManage, hasMultipleWorkspaces }) {
  const menuRef = useRef(null);
  const t = useT();
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (open && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target) && !anchorRef.current?.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed w-56 z-[100] dropdown-enter overflow-hidden py-1"
      style={{
        top: pos.top,
        left: pos.left,
        backgroundColor: 'var(--dialog-background-color)',
        borderRadius: 'var(--border-radius-medium)',
        boxShadow: 'var(--box-shadow-medium)',
        border: '1px solid var(--layout-border-color)',
      }}
    >
      {canCreateWorkspace && (
        <button onClick={() => { onClose(); onAddWorkspace(); }}
          className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
          <Plus size={14} strokeWidth={1.8} /> {t('sidebar.addNewWorkspace')}
        </button>
      )}
      {/* Rearrange Workspaces — visible to every user since the saved order
          is a personal preference. The button is hidden when the user has
          fewer than two workspaces because there's nothing to reorder. */}
      {hasMultipleWorkspaces && (
        <button onClick={() => { onClose(); onRearrangeWorkspaces?.(); }}
          className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
          <ArrowUpDown size={14} strokeWidth={1.8} /> {t('sidebar.rearrangeWorkspaces')}
        </button>
      )}
      <button onClick={() => { onClose(); onNavigate('/boards'); }}
        className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
        <LayoutGrid size={14} strokeWidth={1.8} /> {t('sidebar.browseAllBoards')}
      </button>
      {/* Phase 1 — "Browse all workspaces" opens the dedicated modal instead
          of routing to /admin-settings. Visible to every user (not just
          managers) since the browse view itself respects per-row tier checks. */}
      <button onClick={() => { onClose(); onBrowseAllWorkspaces?.(); }}
        className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
        <Puzzle size={14} strokeWidth={1.8} /> {t('sidebar.browseAllWorkspaces')}
      </button>
      {canManage && (
        <button onClick={() => { onClose(); onNavigate('/archive'); }}
          className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
          <Archive size={14} strokeWidth={1.8} /> {t('sidebar.viewArchive')}
        </button>
      )}
    </div>,
    document.body
  );
}

export default function Sidebar({ collapsed, onToggle }) {
  const { user, canManage, isAdmin, isStrictAdmin, isManager, isAssistantManager, isDirector, isSuperAdmin, permissionGrants, effectivePermissions, granularPermissions } = useAuth();
  const t = useT();
  // Global "Approvals & Requests" badge — total of approval items the caller
  // can act on, plus pending extensions (managers+ only) and unresolved help
  // requests where the caller is the helper. See useApprovalsBadgeCount /
  // server `getActionablePendingCounts` for the exact semantics.
  const approvalsBadgeCount = useApprovalsBadgeCount();
  const approvalsBadge = formatBadgeCount(approvalsBadgeCount);
  const navigate = useNavigate();
  const location = useLocation();
  const [boards, setBoards] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [openWorkspaces, setOpenWorkspaces] = useState({});
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showCreateBoard, setShowCreateBoard] = useState(false);
  // Workspace context for the create-board modal. `null` means "no workspace"
  // (i.e. the bottom-of-sidebar "Create new board" button); a workspace id
  // means the modal was opened from that workspace's three-dot menu and the
  // new board should land directly inside it.
  const [boardCreationWorkspace, setBoardCreationWorkspace] = useState(null);
  // Profile opens the same overlay modal the Header dropdown uses — navigate
  // to /profile with the current location as background so App.jsx's modal
  // route pattern mounts ProfileModalRoute on top of the page behind it.
  // Keeps both entry points pixel-identical (DetailModalShell bottom-sheet)
  // and avoids a second, divergent right-side drawer.
  const openProfileModal = () => navigate('/profile', { state: { background: location } });
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [wsActionMenu, setWsActionMenu] = useState(null);
  const [boardActionMenu, setBoardActionMenu] = useState(null);
  const [renamingBoard, setRenamingBoard] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingWorkspace, setRenamingWorkspace] = useState(null);
  const [wsRenameValue, setWsRenameValue] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [dragBoardId, setDragBoardId] = useState(null);
  const [dragOverWsId, setDragOverWsId] = useState(null);
  // Per-workspace "Show more / Show less" toggle for the board list. Keyed by
  // workspace id; absent/false = collapsed (first 3 boards), true = expanded.
  const [showAllByWorkspace, setShowAllByWorkspace] = useState({});
  // Workspace currently open in the Rearrange Boards modal, or null when closed.
  const [rearrangeWorkspace, setRearrangeWorkspace] = useState(null);
  // Whether the Rearrange Workspaces modal is open (toggled from the
  // WORKSPACES header three-dot menu). The modal is shared across the
  // whole sidebar — only one instance, no per-workspace context needed.
  const [showRearrangeWorkspaces, setShowRearrangeWorkspaces] = useState(false);
  // Phase 1: full-page Browse All Workspaces modal — replaces the prior
  // /admin-settings redirect for the "browse all workspaces" menu item.
  const [showBrowseAllWorkspaces, setShowBrowseAllWorkspaces] = useState(false);
  // Phase 1: unified "+ Add new" menu popover. Wraps the existing
  // CreateBoard / CreateWorkspace flows so users see one entry point
  // and the menu can grow with future content types.
  const [showAddNewMenu, setShowAddNewMenu] = useState(false);
  // Per-user board ordering: { [workspaceId]: [boardId, boardId, ...] }.
  const [boardOrders, setBoardOrders] = useState({});
  // Per-user workspace ordering (server-persisted). Array of workspaceIds in
  // the order the user wants them rendered. Workspaces present in this list
  // sort first; new/unknown workspaces fall through to the recency-weighted
  // ranking so freshly-created ones still appear without a manual save.
  const [workspaceOrder, setWorkspaceOrder] = useState([]);
  // Per-user workspace usage memory (localStorage-backed) — drives the
  // "top 3 workspaces" sort. Pinned + recency rank, with a Show More toggle.
  const [wsUsage, setWsUsage] = useState(() => readWorkspaceUsage());
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
  const WS_VISIBLE_LIMIT = 3;
  const resizing = useRef(false);
  const wsMenuBtnRef = useRef(null);
  const renameInputRef = useRef(null);

  useEffect(() => { loadData(); }, []);

  useRealtimeQuery({ queryKey: 'boards.list', refetch: loadData });

  // Memoized permission flags — used a few times in the workspace menu render.
  // Computed once per render, not per workspace iteration.
  const canCreateBoardPerm = canUser(user?.role, 'create_board', isSuperAdmin, permissionGrants, effectivePermissions);
  const canEditWsPerm = canUser(user?.role, 'edit_workspace', isSuperAdmin, permissionGrants, effectivePermissions);

  // Best-effort guess at the workspace context for the bottom "Create new
  // board" button. If the user is currently looking at a board, default the
  // new board to that board's workspace; otherwise leave it null and the
  // modal will show a workspace selector.
  function inferCurrentWorkspaceId() {
    const m = location.pathname.match(/^\/boards\/([0-9a-f-]{36})/i);
    if (!m) return null;
    const currentBoard = boards.find(b => b.id === m[1]);
    return currentBoard?.workspaceId || null;
  }

  // Bump a workspace's recency/volume counters whenever the user navigates
  // into one of its boards. Called from the board-row click in the sidebar.
  function bumpWorkspaceUsage(wsId) {
    if (!wsId) return;
    setWsUsage(prev => {
      const entry = prev[wsId] || {};
      const next = {
        ...prev,
        [wsId]: {
          ...entry,
          lastOpenedAt: Date.now(),
          openCount: (entry.openCount || 0) + 1,
        },
      };
      writeWorkspaceUsage(next);
      return next;
    });
  }

  // Toggle the "pinned" flag for a workspace. Pinned workspaces always sort
  // above unpinned ones regardless of recent usage.
  function toggleWorkspacePin(wsId) {
    setWsUsage(prev => {
      const entry = prev[wsId] || {};
      const next = { ...prev, [wsId]: { ...entry, pinned: !entry.pinned } };
      writeWorkspaceUsage(next);
      return next;
    });
  }

  function openRearrangeForWorkspace(ws) {
    setRearrangeWorkspace(ws || null);
  }

  // Drag-and-drop: move board to a different workspace
  async function handleBoardDrop(boardId, targetWsId) {
    if (!boardId) return;
    try {
      await api.put(`/boards/${boardId}`, { workspaceId: targetWsId || null });
      loadData();
    } catch (err) {
      console.error('Failed to move board:', err);
    }
  }

  async function loadData() {
    try {
      // The two preference fetches are marked `_silent` so a 5xx never reaches
      // the global toast handler. They are best-effort — if the table doesn't
      // exist on a stale deployment or the controller blips, we render the
      // sidebar with the default order. Surfacing "Failed to fetch workspace"
      // for a personalisation read would be misleading; the workspace list
      // itself (`/workspaces/mine`) still produces a real error if it fails.
      const [boardsRes, wsRes, ordersRes, wsOrderRes] = await Promise.all([
        api.get('/boards'),
        api.get('/workspaces/mine'),
        api.get('/board-orders/mine', { _silent: true }).catch(() => ({ data: { orders: {} } })),
        api.get('/workspaces/order', { _silent: true }).catch(() => ({ data: { workspaceIds: [] } })),
      ]);
      const allBoards = boardsRes.data.boards || boardsRes.data || [];
      setBoards(allBoards);
      setFavorites(JSON.parse(localStorage.getItem('favoriteBoards') || '[]'));

      const myWorkspaces = wsRes.data.workspaces || wsRes.data.data?.workspaces || [];
      setWorkspaces(myWorkspaces);

      const orders = ordersRes?.data?.orders || ordersRes?.data?.data?.orders || {};
      setBoardOrders(orders);

      // The controller wraps the payload in { data: { workspaceIds } } via
      // the standard success envelope, but the axios interceptor in some
      // deployments strips one level — accept both shapes defensively.
      const wsIds = wsOrderRes?.data?.workspaceIds
        || wsOrderRes?.data?.data?.workspaceIds
        || [];
      setWorkspaceOrder(Array.isArray(wsIds) ? wsIds : []);

      // Default: open first workspace
      if (myWorkspaces.length > 0) {
        setOpenWorkspaces(prev => {
          const next = { ...prev };
          if (Object.keys(next).length === 0) {
            next[myWorkspaces[0].id] = true;
          }
          return next;
        });
      }
    } catch (err) { console.error('Failed to load sidebar data:', err); }
  }

  // Apply the user's saved board order for a given workspace. Boards that
  // appear in the saved order keep that order; any newer/uncovered boards
  // fall through after them in their original (server-default) order. Boards
  // that were removed/archived after saving are skipped silently.
  function applyUserOrder(wsId, wsBoards) {
    const order = boardOrders?.[wsId];
    if (!order || !Array.isArray(order) || order.length === 0) return wsBoards;
    const idIndex = new Map(order.map((id, i) => [id, i]));
    const known = [];
    const unknown = [];
    for (const b of wsBoards) {
      if (idIndex.has(b.id)) known.push(b); else unknown.push(b);
    }
    known.sort((a, b) => idIndex.get(a.id) - idIndex.get(b.id));
    return [...known, ...unknown];
  }

  async function handleCreateBoard(data) {
    // The modal already adds workspaceId to the payload when one was provided
    // via props, but we also defensively merge in the current sidebar state so
    // that the workspace context can never be silently lost.
    const payload = { ...data };
    if (boardCreationWorkspace?.id && !payload.workspaceId) {
      payload.workspaceId = boardCreationWorkspace.id;
    }
    const res = await api.post('/boards', payload);
    const newBoard = res.data.board || res.data;
    // Auto-expand the workspace where the board was created so the new
    // entry is immediately visible.
    if (newBoard?.workspaceId) {
      setOpenWorkspaces(prev => ({ ...prev, [newBoard.workspaceId]: true }));
    }
    loadData();
    setShowCreateBoard(false);
    setBoardCreationWorkspace(null);
    navigate(`/boards/${newBoard.id}`);
  }

  // Open the create-board modal pre-bound to a specific workspace.
  function openCreateBoardForWorkspace(ws) {
    setBoardCreationWorkspace(ws || null);
    setShowCreateBoard(true);
  }

  function toggleFavorite(e, boardId) {
    e.stopPropagation();
    setFavorites(prev => {
      const next = prev.includes(boardId) ? prev.filter(id => id !== boardId) : [...prev, boardId];
      localStorage.setItem('favoriteBoards', JSON.stringify(next));
      return next;
    });
  }

  function startRename(board) {
    setRenamingBoard(board.id);
    setRenameValue(board.name);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  }

  async function saveRename(boardId) {
    if (renameValue.trim() && renameValue.trim() !== boards.find(b => b.id === boardId)?.name) {
      try { await api.put(`/boards/${boardId}`, { name: renameValue.trim() }); loadData(); } catch {}
    }
    setRenamingBoard(null);
  }

  function handleMouseDown(e) {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    function onMouseMove(ev) {
      if (!resizing.current) return;
      setSidebarWidth(Math.max(200, Math.min(380, startW + ev.clientX - startX)));
    }
    function onMouseUp() {
      resizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  const isActive = (path) => location.pathname === path;
  const isBoardActive = (id) => location.pathname.startsWith(`/boards/${id}`);
  const favoriteBoards = boards.filter(b => favorites.includes(b.id));

  // Boards not in any workspace shown under a default "My Boards" section
  const boardsInWorkspaces = new Set(workspaces.flatMap(ws => (ws.boards || []).map(b => b.id)));
  const unassignedBoards = boards.filter(b => !boardsInWorkspaces.has(b.id));
  const filteredUnassigned = searchQuery
    ? unassignedBoards.filter(b => b.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : unassignedBoards;

  // Optional `badge` is a string already formatted by formatBadgeCount() —
  // null/undefined hides the dot completely. Lives on the right of the row,
  // matches the bell-badge styling so the visual language is consistent.
  const NavItem = ({ icon: Icon, label, path, tourId, badge }) => (
    <button onClick={() => navigate(path)}
      data-tour={tourId || undefined}
      aria-label={badge ? `${label} (${badge} pending)` : label}
      className={`sidebar-item w-full ${isActive(path) ? 'sidebar-item-active' : ''}`}>
      <Icon size={16} strokeWidth={1.8} />
      <span className="flex-1 text-left truncate">{label}</span>
      {badge && (
        <span
          className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[16px] px-1.5 rounded-full bg-danger text-white text-[9px] font-bold leading-none"
          aria-live="polite"
          aria-atomic="true"
        >
          {badge}
        </span>
      )}
    </button>
  );

  function renderBoardItem(board, wsId = null) {
    const menuOpen = boardActionMenu === board.id;
    const isFav = favorites.includes(board.id);
    return (
      <div key={board.id}
        draggable
        onDragStart={(e) => { setDragBoardId(board.id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => { setDragBoardId(null); setDragOverWsId(null); }}
        className={`group relative flex items-center ${dragBoardId === board.id ? 'opacity-40' : ''}`}>
        {renamingBoard === board.id ? (
          <div className="flex-1 px-2 py-1">
            <input ref={renameInputRef} type="text" value={renameValue} onChange={e => setRenameValue(e.target.value)}
              onBlur={() => saveRename(board.id)}
              onKeyDown={e => { if (e.key === 'Enter') saveRename(board.id); if (e.key === 'Escape') setRenamingBoard(null); }}
              className="w-full text-[13px] px-2 py-1 border border-sidebar-accent rounded-md outline-none bg-sidebar-bg text-sidebar-text-active" />
          </div>
        ) : (
          <>
            <button onClick={() => { bumpWorkspaceUsage(wsId); navigate(`/boards/${board.id}`); }}
              className={`sidebar-item flex-1 text-[13px] ${isBoardActive(board.id) ? 'sidebar-item-active' : ''}`}>
              <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: board.color || '#579bfc' }} />
              <span className={`truncate flex-1 text-left transition-[padding] duration-150 ${menuOpen ? 'pr-5' : 'group-hover:pr-5'}`}>{board.name}</span>
            </button>
            {/* 3-dot trigger — RIGHT side of the title row (ChatGPT-style). The
                title's pr-5 reserves space so it truncates before the icon. */}
            <button
              onClick={(e) => { e.stopPropagation(); setBoardActionMenu(menuOpen ? null : board.id); }}
              className={`absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded text-sidebar-text/60 hover:text-sidebar-text-active hover:bg-sidebar-hover transition-opacity ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
              title="Board actions">
              <MoreHorizontal size={12} />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setBoardActionMenu(null)} />
                <div
                  className="absolute right-2 top-full mt-0.5 z-50 w-32 py-1 dropdown-enter"
                  style={{
                    backgroundColor: 'var(--dialog-background-color)',
                    borderRadius: 'var(--border-radius-medium)',
                    boxShadow: 'var(--box-shadow-medium)',
                    border: '1px solid var(--layout-border-color)',
                  }}
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); setBoardActionMenu(null); startRename(board); }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-100 transition-colors">
                    <Edit3 size={12} /> Edit
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setBoardActionMenu(null); toggleFavorite(e, board.id); }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-100 transition-colors">
                    {isFav ? <Star size={12} className="fill-amber-400 text-amber-400" /> : <StarOff size={12} />}
                    {isFav ? 'Unstar' : 'Star'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    );
  }

  // Collapsed-mode inner content (icons-only). Rendered inside the same
  // outer container as the expanded view so the width transition is smooth.
  const collapsedInner = (
    <>
      <button onClick={onToggle} className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#0073ea] to-[#00a0f5] flex items-center justify-center mb-2 shadow-sm">
        <FolderKanban size={15} className="text-white" />
      </button>
      <div className="w-5 border-t border-sidebar-border my-1" />
      {[
        { icon: Home, path: '/', label: t('sidebar.dashboard') },
        { icon: User, path: '/my-work', label: t('sidebar.myWork') },
        { icon: CalendarDays, path: '/meetings', label: t('sidebar.meetings') },
        // Phase 4: AI Notetaker — Monday-style landing for meeting transcripts
        // and summaries. Coexists with the classic /meetings list view.
        { icon: Sparkles, path: '/notetaker', label: 'AI Notetaker' },
      ].map(item => (
        <button key={item.path} onClick={() => navigate(item.path)}
          className={`p-2 rounded-md transition-all duration-150 ${isActive(item.path) ? 'bg-sidebar-active text-sidebar-accent' : 'text-sidebar-text hover:bg-sidebar-hover hover:text-sidebar-text-active'}`}
          title={item.label}>
          <item.icon size={18} strokeWidth={1.8} />
        </button>
      ))}
      {(canManage || !!granularPermissions['dashboard.view']) && (
        <>
          <div className="w-5 border-t border-sidebar-border my-1" />
          <button onClick={() => navigate('/dashboard')}
            className={`p-2 rounded-md transition-all duration-150 ${isActive('/dashboard') ? 'bg-sidebar-active text-sidebar-accent' : 'text-sidebar-text hover:bg-sidebar-hover hover:text-sidebar-text-active'}`}
            title={t('sidebar.teamDashboard')}>
            <BarChart3 size={18} strokeWidth={1.8} />
          </button>
        </>
      )}
      <div className="mt-auto">
        <button onClick={openProfileModal}
          className="w-7 h-7 rounded-full bg-gradient-to-br from-[#0073ea] to-[#00a0f5] flex items-center justify-center text-white text-[10px] font-semibold"
          title={t('profile.title')}>
          {user?.name?.charAt(0)?.toUpperCase() || 'U'}
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile backdrop overlay */}
      <div
        className={`fixed inset-0 bg-black/40 z-40 md:hidden transition-opacity duration-200 ${collapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
        onClick={onToggle}
      />
      <div data-tour="sidebar" style={{ width: collapsed ? 52 : sidebarWidth, transition: resizing.current ? 'none' : 'width 280ms cubic-bezier(0.4, 0, 0.2, 1)' }}
        className={`bg-sidebar-bg flex flex-col flex-shrink-0 h-full border-r border-sidebar-border relative select-none overflow-hidden
          ${collapsed ? 'items-center py-3 gap-1' : ''}
          max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-2xl
          ${collapsed ? 'max-md:-translate-x-full' : 'max-md:translate-x-0'}
          max-md:transition-transform max-md:duration-200`}>
        {collapsed ? collapsedInner : (<>

        {/* === FIXED TOP: Logo only === */}
        <div className="flex-shrink-0">
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-sidebar-border">
            <img src="/icons/anistonlogo.png" alt="Monday Aniston" className="w-7 h-7 rounded-lg object-contain flex-shrink-0" />
            <h1 className="text-sidebar-text-active text-[13px] font-bold truncate leading-tight flex-1">Monday Aniston</h1>
            <button onClick={onToggle} className="text-sidebar-text/50 hover:text-sidebar-text-active p-1 rounded-md hover:bg-sidebar-hover transition-all duration-150">
              <PanelLeftClose size={15} />
            </button>
          </div>
        </div>

        {/* === FULLY SCROLLABLE MIDDLE SECTION (nav + workspaces) === */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-sidebar">

          {/* Main Nav — Dashboard (formerly Home) is the personal overview
              at `/`. "My Dashboard" (the role-routed pages) was folded into
              Dashboard; the old paths redirect there. My Work is now
              available to every tier, including Tier 1 / Super Admin —
              its /tasks?assignedTo=me data source is server-scoped to the
              caller, so it stays personal regardless of role. */}
          <nav className="py-2 flex flex-col gap-0.5">
            <NavItem icon={Home} label={t('sidebar.dashboard')} path="/" tourId="nav-home" />
            <NavItem icon={User} label={t('sidebar.myWork')} path="/my-work" tourId="nav-mywork" />
            {/* Org Chart and Time Plan moved to header icons (see Header.jsx). */}
            <NavItem icon={CalendarDays} label={t('sidebar.meetings')} path="/meetings" tourId="nav-meetings" />
            {/* Phase 4: AI Notetaker landing — alongside the classic /meetings
                list. Uses the same /api/meetings/my data source but adds the
                3-column detail page, transcript viewer, and settings modal. */}
            <NavItem icon={Sparkles} label="AI Notetaker" path="/notetaker" tourId="nav-notetaker" />
            {/* Doc Editor — top-level entry, always visible. Points at the
                tier-agnostic /docs landing which resolves the caller's
                first workspace and redirects (or shows a friendly empty
                state when they belong to none). Earlier versions gated
                this row on `workspaces.length`, which hid the link entirely
                for fresh members on day one. */}
            <NavItem icon={BookOpen} label="Docs" path="/docs" tourId="nav-docs" />
            {/* Workflow Canvas (Phase W1) — visual trigger → action automations.
                Sits between Docs and Reviews because it pairs with collaborative
                editing surfaces, not the analytics ones below. May-19 audit:
                T1/T2 see this row by default (canManage); T3/T4 must hold an
                explicit `workflows.view` grant. The backend enforces the same
                rule via requirePermission('workflows', 'view') on every
                /api/workflows endpoint — this flag is purely UX. */}
            {(canManage || !!granularPermissions['workflows.view']) && (
              <NavItem icon={Workflow} label="Workflows" path="/workflows" tourId="nav-workflows" />
            )}
            {/* Forms (Phase F1) — public & internal intake forms. Same band as
                Workflows / Docs since they share the "build a thing once,
                use it many times" mental model. */}
            <NavItem icon={FileSpreadsheet} label="Forms" path="/forms" tourId="nav-forms" />
            <NavItem icon={FileText} label={t('sidebar.reviews')} path="/reviews" tourId="nav-reviews" />
            <NavItem icon={ClipboardCheck} label={t('sidebar.approvalsAndRequests')} path="/tasks" tourId="nav-tasks" badge={approvalsBadge} />
            <NavItem icon={RefreshCw} label={t('sidebar.recurringWork')} path="/recurring-work" tourId="nav-recurring-work" />
          </nav>

          {(canManage || !!granularPermissions['dashboard.view']) && (
            <>
              <div className="border-t border-sidebar-border mx-3 my-1" />
              <nav className="py-1 flex flex-col gap-0.5">
                {(canManage || !!granularPermissions['dashboard.view']) && (
                  <NavItem icon={BarChart3} label={t('sidebar.teamDashboard')} path="/dashboard" tourId="nav-dashboard" />
                )}
              </nav>
            </>
          )}

          {/* Admin Settings, Integrations, Feedback, Archive moved to the
              profile dropdown in the top-right header. Same permission gates
              live there now (see Header.jsx). */}

          {/* Workspace section divider */}
          <div className="border-t border-sidebar-border mx-3 my-1" />

          {/* Favorites */}
          {favoriteBoards.length > 0 && (
            <div className="px-2 pt-2">
              <button onClick={() => setFavoritesOpen(!favoritesOpen)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-wide text-sidebar-text/60 font-semibold w-full hover:text-sidebar-text transition-colors">
                <ChevronRight size={10} className={`transition-transform duration-150 ${favoritesOpen ? 'rotate-90' : ''}`} />
                {t('sidebar.favorites')}
              </button>
              {favoritesOpen && (
                <div className="animate-fade-in">
                  {favoriteBoards.map(board => (
                    <button key={board.id} onClick={() => navigate(`/boards/${board.id}`)}
                      className={`sidebar-item text-[13px] w-full ${isBoardActive(board.id) ? 'sidebar-item-active' : ''}`}>
                      <div className="w-2.5 h-2.5 rounded flex-shrink-0" style={{ backgroundColor: board.color || '#579bfc' }} />
                      <span className="truncate flex-1 text-left">{board.name}</span>
                      <Star size={11} className="text-amber-400 fill-amber-400 flex-shrink-0" onClick={(e) => toggleFavorite(e, board.id)} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Workspace Header */}
          <div data-tour="workspaces" className="flex items-center justify-between px-5 py-1.5 mt-1">
            <span className="text-[11px] uppercase tracking-wide text-sidebar-text/60 font-semibold">{t('sidebar.workspaces')}</span>
            <div className="flex items-center gap-0.5">
              <button ref={wsMenuBtnRef} onClick={() => setWsMenuOpen(!wsMenuOpen)}
                className="p-1 rounded-md text-sidebar-text/40 hover:text-sidebar-text hover:bg-sidebar-hover transition-all duration-150" title="Workspace options">
                <MoreHorizontal size={14} />
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="px-3 pb-1">
            <div className="flex items-center gap-2 bg-sidebar-hover rounded-md px-2.5 py-[6px] border border-transparent focus-within:border-sidebar-accent/30 transition-all duration-150">
              <Search size={12} className="text-sidebar-text/50 flex-shrink-0" />
              <input type="text" placeholder={t('sidebar.searchBoards')} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-transparent border-none outline-none text-sidebar-text-active text-xs w-full placeholder:text-sidebar-text/40 shadow-none ring-0 focus:ring-0" />
            </div>
          </div>

          {/* Dynamic Workspaces — sorted by pinned + recency, sliced to top
              WS_VISIBLE_LIMIT (3) by default with a Show More toggle. The
              workspace containing the currently-open board is always kept
              visible so the user never loses context after navigating into a
              board they don't normally visit. When the user is searching,
              we suspend the slicing so search hits aren't hidden behind a
              collapsed list. */}
          {(() => {
            // Sort precedence:
            //   1. Pinned workspaces float above unpinned (existing behavior,
            //      driven by per-user localStorage `wsUsage[id].pinned`).
            //   2. Within each group (pinned / unpinned), the user's saved
            //      manual order from "Rearrange Workspaces" wins. Workspaces
            //      not present in the saved order get position=Infinity so
            //      they fall through to the existing recency-weighted score.
            //   3. Tie-breaker is the recency/volume score, so brand-new
            //      workspaces that the user hasn't reordered yet still get
            //      surfaced based on actual usage.
            const orderIdx = new Map((workspaceOrder || []).map((id, i) => [id, i]));
            const sortedWorkspaces = [...workspaces].sort((a, b) => {
              const ea = wsUsage[a.id] || {};
              const eb = wsUsage[b.id] || {};
              if (!!ea.pinned !== !!eb.pinned) return ea.pinned ? -1 : 1;
              const ai = orderIdx.has(a.id) ? orderIdx.get(a.id) : Infinity;
              const bi = orderIdx.has(b.id) ? orderIdx.get(b.id) : Infinity;
              if (ai !== bi) return ai - bi;
              return workspaceScore(eb) - workspaceScore(ea);
            });
            const activeWsId = inferCurrentWorkspaceId();

            // Search mode splits the render into "promoted board matches" and
            // "matching workspaces". The old code only filtered boards *inside*
            // every workspace by name match, which produced the "No boards match"
            // empty state under workspaces whose own name matched the query but
            // whose board names didn't. New behavior:
            //   - Matching boards (across the whole sidebar, including
            //     unassigned) are listed at the top so they're one click away.
            //   - Matching workspaces render with ALL their boards visible.
            //   - To avoid double-rendering a board, a board that already shows
            //     up under a matching workspace is omitted from the top list.
            // Both lists only read from `workspaces` / `unassignedBoards`, which
            // are already permission-filtered server-side — no RBAC bypass.
            const normalizedQuery = searchQuery.trim().toLowerCase();
            const isSearching = !!normalizedQuery;

            let visibleWorkspaces;
            let matchingBoards = [];
            let hiddenWsCount = 0;

            if (isSearching) {
              visibleWorkspaces = sortedWorkspaces.filter(ws =>
                (ws.name || '').toLowerCase().includes(normalizedQuery)
              );
              const matchingWsIds = new Set(visibleWorkspaces.map(w => w.id));
              const allVisibleBoards = [
                ...workspaces.flatMap(ws =>
                  (ws.boards || []).map(b => ({
                    ...b,
                    parentWorkspaceId: ws.id,
                    parentWorkspaceName: ws.name,
                  }))
                ),
                ...unassignedBoards.map(b => ({
                  ...b,
                  parentWorkspaceId: null,
                  parentWorkspaceName: null,
                })),
              ];
              matchingBoards = allVisibleBoards.filter(b =>
                (b.name || '').toLowerCase().includes(normalizedQuery)
                && !matchingWsIds.has(b.parentWorkspaceId)
              );
            } else {
              const collapse = !showAllWorkspaces && sortedWorkspaces.length > WS_VISIBLE_LIMIT;
              visibleWorkspaces = collapse ? sortedWorkspaces.slice(0, WS_VISIBLE_LIMIT) : sortedWorkspaces;
              if (collapse && activeWsId && !visibleWorkspaces.some(w => w.id === activeWsId)) {
                const ws = sortedWorkspaces.find(w => w.id === activeWsId);
                if (ws) visibleWorkspaces = [...visibleWorkspaces, ws];
              }
              hiddenWsCount = Math.max(0, sortedWorkspaces.length - WS_VISIBLE_LIMIT);
            }

            const noResults = isSearching
              && matchingBoards.length === 0
              && visibleWorkspaces.length === 0
              && (workspaces.length > 0 || boards.length > 0);

            return (
          <div className="px-2 pb-2 space-y-1">
            {/* Promoted "Matching boards" — search mode only. Renders directly
                below the search input so name hits are one click away instead
                of buried inside their parent workspace. */}
            {isSearching && matchingBoards.length > 0 && (
              <div className="mb-1">
                <div className="px-3 pt-1 pb-0.5">
                  <span className="text-[10px] uppercase tracking-wide text-sidebar-text/40 font-semibold">
                    Matching boards
                  </span>
                </div>
                {matchingBoards.map(board => (
                  <button
                    key={`match-${board.id}`}
                    onClick={() => { bumpWorkspaceUsage(board.parentWorkspaceId); navigate(`/boards/${board.id}`); }}
                    className={`sidebar-item w-full text-[13px] items-start ${isBoardActive(board.id) ? 'sidebar-item-active' : ''}`}
                  >
                    <div className="w-2 h-2 rounded-sm flex-shrink-0 mt-[5px]" style={{ backgroundColor: board.color || '#579bfc' }} />
                    <div className="flex-1 min-w-0 text-left">
                      <div className="truncate leading-tight">{board.name}</div>
                      {board.parentWorkspaceName && (
                        <div className="truncate text-[10px] text-sidebar-text/40 leading-tight mt-0.5">
                          {board.parentWorkspaceName}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {visibleWorkspaces.map(ws => {
              // KEY FIX: when the workspace itself matched the search query,
              // show ALL its boards. The old code unconditionally filtered
              // boards by name match, producing the "No boards match" empty
              // state under every matched workspace. Only matching workspaces
              // appear during search, so `ws.boards` is already the right list.
              const wsBoards = applyUserOrder(ws.id, ws.boards || []);
              // Auto-expand workspaces during search so the boards inside
              // matching workspaces are immediately visible (per UX spec A).
              const isOpen = isSearching || openWorkspaces[ws.id] !== false;

              return (
                <div key={ws.id}
                  onDragOver={(e) => { if (dragBoardId) { e.preventDefault(); setDragOverWsId(ws.id); } }}
                  onDragLeave={() => setDragOverWsId(null)}
                  onDrop={(e) => { e.preventDefault(); if (dragBoardId) { handleBoardDrop(dragBoardId, ws.id); setDragBoardId(null); setDragOverWsId(null); } }}
                  className={`group/ws relative transition-all ${dragOverWsId === ws.id ? 'bg-sidebar-hover ring-1 ring-sidebar-accent rounded-md' : ''}`}>
                  {/* Workspace row. Per UX requirement, only the chevron
                      toggles the board list — clicking the title/name does
                      nothing. The row is a div (not a button) so accidental
                      title clicks don't collapse the workspace.

                      Right-clicking the row opens a ContextMenu (Monday
                      parity); the existing hover-MoreHorizontal dropdown
                      stays as the discoverable affordance for mouse users
                      who don't know right-click is wired. */}
                  <ContextMenu>
                  <ContextMenu.Trigger asChild>
                  <div
                    className="flex items-center gap-2 pl-3 pr-7 py-1.5 w-full hover:bg-sidebar-hover rounded-md transition-colors cursor-default">
                    <div className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0 text-white text-[10px] font-bold"
                      style={{ backgroundColor: ws.color || '#0073ea' }}>
                      {ws.name.charAt(0).toUpperCase()}
                    </div>
                    {renamingWorkspace === ws.id ? (
                      <input
                        autoFocus
                        value={wsRenameValue}
                        onChange={(e) => setWsRenameValue(e.target.value)}
                        onBlur={() => {
                          if (wsRenameValue.trim() && wsRenameValue !== ws.name) {
                            api.put(`/workspaces/${ws.id}`, { name: wsRenameValue.trim() }).then(() => loadData());
                          }
                          setRenamingWorkspace(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.target.blur();
                          if (e.key === 'Escape') { setRenamingWorkspace(null); }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="text-[13px] font-semibold text-sidebar-text-active flex-1 bg-sidebar-hover rounded px-1 py-0.5 outline-none border border-primary/40"
                      />
                    ) : (
                      <span className="text-[13px] font-semibold text-sidebar-text-active flex-1 text-left truncate">{ws.name}</span>
                    )}
                    {wsUsage[ws.id]?.pinned && (
                      <Pin size={10} className="text-sidebar-accent flex-shrink-0 mr-0.5" title="Pinned" />
                    )}
                    {ws.workspaceMembers?.length > 0 && (
                      <span className="text-[10px] text-sidebar-text/40 mr-1">{ws.workspaceMembers.length}</span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setOpenWorkspaces(prev => ({ ...prev, [ws.id]: !isOpen })); }}
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${ws.name} workspace`}
                      title={isOpen ? 'Collapse workspace' : 'Expand workspace'}
                      className="flex items-center justify-center p-0.5 -mr-0.5 rounded text-sidebar-text/40 hover:text-sidebar-text-active hover:bg-sidebar-hover/70 transition-colors flex-shrink-0 cursor-pointer">
                      <ChevronDown size={13} className={`transition-transform duration-150 ${isOpen ? '' : '-rotate-90'}`} />
                    </button>
                  </div>
                  </ContextMenu.Trigger>
                  <ContextMenu.Content ariaLabel={`Workspace ${ws.name} actions`}>
                    <ContextMenu.Item
                      icon={wsUsage[ws.id]?.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                      onSelect={() => toggleWorkspacePin(ws.id)}
                    >
                      {wsUsage[ws.id]?.pinned ? t('sidebar.unpinFromTop') : t('sidebar.pinToTop')}
                    </ContextMenu.Item>
                    {canCreateBoardPerm && (
                      <ContextMenu.Item
                        icon={<Plus size={14} />}
                        onSelect={() => openCreateBoardForWorkspace(ws)}
                      >
                        {t('sidebar.createBoard')}
                      </ContextMenu.Item>
                    )}
                    <ContextMenu.Item
                      icon={<ArrowUpDown size={14} />}
                      onSelect={() => openRearrangeForWorkspace(ws)}
                    >
                      {t('sidebar.rearrangeBoards')}
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      icon={<Users size={14} />}
                      onSelect={() => navigate(`/workspaces/${ws.id}`)}
                    >
                      Manage members
                    </ContextMenu.Item>
                    {canEditWsPerm && <ContextMenu.Separator />}
                    {canEditWsPerm && (
                      <ContextMenu.Item
                        icon={<Edit3 size={14} />}
                        onSelect={() => { setRenamingWorkspace(ws.id); setWsRenameValue(ws.name); }}
                      >
                        {t('common.rename')}
                      </ContextMenu.Item>
                    )}
                    {canEditWsPerm && (
                      <ContextMenu.Item
                        icon={<Archive size={14} />}
                        onSelect={() => {
                          if (window.confirm(`Archive workspace "${ws.name}"? All boards inside will be hidden.`)) {
                            api.put(`/workspaces/${ws.id}`, { isActive: false }).then(() => loadData());
                          }
                        }}
                      >
                        {t('sidebar.archiveWorkspace')}
                      </ContextMenu.Item>
                    )}
                    {canEditWsPerm && (
                      <ContextMenu.Item
                        destructive
                        icon={<Trash2 size={14} />}
                        onSelect={() => {
                          if (window.confirm(`Permanently delete workspace "${ws.name}"? This cannot be undone.`)) {
                            api.delete(`/workspaces/${ws.id}`)
                              .then(() => loadData())
                              .catch((err) => window.alert(err?.response?.data?.message || 'Could not delete workspace.'));
                          }
                        }}
                      >
                        Delete workspace
                      </ContextMenu.Item>
                    )}
                  </ContextMenu.Content>
                  </ContextMenu>
                  {/* Workspace hover menu — always rendered (every user can
                      personally pin/unpin), but each item inside is gated by
                      its own permission. Assistant managers with the
                      board-create grant still see Create/Rearrange; only
                      edit_workspace holders see Rename/Archive. */}
                  <div className="absolute right-2 top-1 opacity-0 group-hover/ws:opacity-100 transition-opacity z-10">
                    <div className="relative">
                      <button onClick={(e) => { e.stopPropagation(); setWsActionMenu(wsActionMenu === ws.id ? null : ws.id); }}
                        className="p-1 rounded-md text-sidebar-text/30 hover:text-sidebar-text hover:bg-sidebar-hover transition-colors">
                        <MoreHorizontal size={13} />
                      </button>
                      {wsActionMenu === ws.id && (
                        <div
                          className="absolute right-0 top-full mt-1 w-48 py-1 z-50"
                          style={{
                            backgroundColor: 'var(--dialog-background-color)',
                            borderRadius: 'var(--border-radius-medium)',
                            boxShadow: 'var(--box-shadow-medium)',
                            border: '1px solid var(--layout-border-color)',
                          }}
                          onMouseLeave={() => setWsActionMenu(null)}
                        >
                          {/* Personal pin — available to every role since it
                              only writes to localStorage. Pinned workspaces
                              float to the top of the sidebar list. */}
                          <button onClick={() => { toggleWorkspacePin(ws.id); setWsActionMenu(null); }}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-100">
                            {wsUsage[ws.id]?.pinned
                              ? <><PinOff size={12} /> {t('sidebar.unpinFromTop')}</>
                              : <><Pin size={12} /> {t('sidebar.pinToTop')}</>
                            }
                          </button>
                          {canCreateBoardPerm && (
                            <button onClick={() => { setWsActionMenu(null); openCreateBoardForWorkspace(ws); }}
                              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-100">
                              <Plus size={12} /> {t('sidebar.createBoard')}
                            </button>
                          )}
                          {/* "Rearrange Boards" is available to every tier
                              (T1–T4). The saved order is per-user, the modal
                              only lists boards the caller can see, and the
                              backend `PUT /workspaces/:id/board-order` route
                              re-checks per-board visibility — so there is no
                              privilege escalation in letting members reorder
                              their own sidebar view. We deliberately do NOT
                              gate this on canEditWsPerm / canManage; those
                              still control Rename / Archive Workspace below. */}
                          <button onClick={() => { setWsActionMenu(null); openRearrangeForWorkspace(ws); }}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-100">
                            <ArrowUpDown size={12} /> {t('sidebar.rearrangeBoards')}
                          </button>
                          {canEditWsPerm && (
                            <button onClick={() => { setRenamingWorkspace(ws.id); setWsRenameValue(ws.name); setWsActionMenu(null); }}
                              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-100">
                              <Edit3 size={12} /> {t('common.rename')}
                            </button>
                          )}
                          {canEditWsPerm && (
                            <button onClick={() => { if (confirm(`Archive workspace "${ws.name}"? All boards inside will be hidden.`)) { api.put(`/workspaces/${ws.id}`, { isActive: false }).then(() => loadData()); } setWsActionMenu(null); }}
                              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-500/10">
                              <Archive size={12} /> {t('sidebar.archiveWorkspace')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {isOpen && (() => {
                    // Per-workspace "show more / show less" — collapse to the
                    // first 3 boards by default, with a toggle to reveal the
                    // rest. During search the cap is suspended so every board
                    // inside a matching workspace is visible (per UX spec A).
                    // The active board (if any) is always kept visible even
                    // when collapsed so the user never loses context.
                    const BOARD_LIMIT = 3;
                    const showAll = isSearching || !!showAllByWorkspace[ws.id];
                    const hasMore = !isSearching && wsBoards.length > BOARD_LIMIT;
                    let visible = (showAll || !hasMore) ? wsBoards : wsBoards.slice(0, BOARD_LIMIT);
                    if (!showAll && hasMore) {
                      const activeBoard = wsBoards.find(b => isBoardActive(b.id));
                      if (activeBoard && !visible.some(b => b.id === activeBoard.id)) {
                        visible = [...visible, activeBoard];
                      }
                    }
                    const hiddenCount = Math.max(0, wsBoards.length - BOARD_LIMIT);
                    return (
                      <div className="ml-4 mt-0.5 border-l border-sidebar-border pl-1 animate-fade-in">
                        {visible.map(board => renderBoardItem(board, ws.id))}
                        {hasMore && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setShowAllByWorkspace(prev => ({ ...prev, [ws.id]: !showAll })); }}
                            className="flex items-center gap-1.5 w-full px-3 py-1 text-[11px] text-sidebar-text/60 hover:text-sidebar-accent hover:bg-sidebar-hover rounded-md transition-colors">
                            <ChevronDown size={11} className={`transition-transform duration-150 ${showAll ? 'rotate-180' : ''}`} />
                            {showAll ? 'Show less' : `Show ${hiddenCount} more`}
                          </button>
                        )}
                        {/* Empty state — only fires when the workspace genuinely
                            has zero boards. The search "No boards match" branch
                            is no longer reachable because search-mode rendering
                            shows ALL boards inside matching workspaces. */}
                        {wsBoards.length === 0 && (
                          <p className="text-sidebar-text/40 text-[11px] px-3 py-1.5">{t('sidebar.noBoardsYet')}</p>
                        )}
                        {/* feat/docs-personal-notion Phase 1: per-workspace
                            Docs sub-row removed. Docs are personal in the new
                            model; the top-level "Docs" nav entry is the only
                            entry point. */}
                      </div>
                    );
                  })()}
                </div>
              );
            })}

            {/* Unassigned boards (not in any workspace). Hidden during search
                because matching unassigned boards are promoted into the
                "Matching boards" top section above. */}
            {!isSearching && filteredUnassigned.length > 0 && (
              <div
                onDragOver={(e) => { if (dragBoardId) { e.preventDefault(); setDragOverWsId('unassigned'); } }}
                onDragLeave={() => setDragOverWsId(null)}
                onDrop={(e) => { e.preventDefault(); if (dragBoardId) { handleBoardDrop(dragBoardId, null); setDragBoardId(null); setDragOverWsId(null); } }}
                className={`transition-all ${dragOverWsId === 'unassigned' ? 'bg-sidebar-hover ring-1 ring-sidebar-accent rounded-md' : ''}`}>
                {workspaces.length > 0 && (
                  <div className="px-3 py-1 mt-1">
                    <span className="text-[10px] uppercase tracking-wide text-sidebar-text/40">{t('sidebar.otherBoards')}</span>
                  </div>
                )}
                <div className="ml-4 border-l border-sidebar-border pl-1">
                  {filteredUnassigned.map(board => renderBoardItem(board))}
                </div>
              </div>
            )}

            {/* Search-mode no-results — only when there's data to search but
                nothing matched. Empty-account fallback below stays separate. */}
            {noResults && (
              <p className="text-sidebar-text/40 text-[11px] px-3 py-2">No boards or workspaces match</p>
            )}

            {boards.length === 0 && workspaces.length === 0 && (
              <p className="text-sidebar-text/40 text-[11px] px-3 py-2">{t('sidebar.noBoardsYet')}</p>
            )}

            {/* Workspace-level Show More toggle. Only renders when more than
                WS_VISIBLE_LIMIT workspaces exist and the user isn't searching
                (search bypasses the cap so all hits are visible). */}
            {!isSearching && sortedWorkspaces.length > WS_VISIBLE_LIMIT && (
              <button
                onClick={() => setShowAllWorkspaces(v => !v)}
                className="flex items-center gap-1.5 w-full px-3 py-1.5 mt-1 text-[11px] text-sidebar-text/60 hover:text-sidebar-accent hover:bg-sidebar-hover rounded-md transition-colors">
                <ChevronDown size={11} className={`transition-transform duration-150 ${showAllWorkspaces ? 'rotate-180' : ''}`} />
                {showAllWorkspaces ? 'Show fewer workspaces' : `Show ${hiddenWsCount} more workspace${hiddenWsCount === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
            );
          })()}

          {/* Removed 2026-05-17: standalone "+ Add new workspace" button was
              a duplicate of the "Workspace" item inside AddNewContentMenu
              below. Both gated on the same `create_workspace` permission,
              both opened CreateWorkspaceModal. The Popover is the canonical
              entry point and surfaces every content type uniformly — having
              two "Add workspace" affordances three lines apart was confusing
              (called out by the user in the May-17 audit). */}

          {/* Create Board — visible to anyone with create_board permission.
              Phase 1: the bottom button now opens the unified "Add new"
              Popover (AddNewContentMenu) instead of jumping straight into
              CreateBoardModal. The menu still surfaces Board as the first
              item — same number of clicks for the common case — but also
              exposes Workspace (and future Doc / Dashboard / Form /
              Workflow / Folder once those handlers are wired). */}
          {canCreateBoardPerm && (
            <div className="px-2 pb-4">
              <AddNewContentMenu
                open={showAddNewMenu}
                onOpenChange={setShowAddNewMenu}
                placement="top-start"
                trigger={
                  <button
                    className="flex items-center gap-2 px-3 py-1.5 w-full text-sidebar-text/50 hover:text-sidebar-accent hover:bg-sidebar-hover rounded-md transition-colors text-[13px]"
                  >
                    <Plus size={14} /> Add new
                  </button>
                }
                onCreateBoard={() => {
                  const inferredWsId = inferCurrentWorkspaceId();
                  const inferredWs = inferredWsId ? workspaces.find(w => w.id === inferredWsId) : null;
                  setBoardCreationWorkspace(inferredWs || null);
                  setShowCreateBoard(true);
                }}
                onCreateWorkspace={() => setShowCreateWorkspace(true)}
                // feat/docs-personal-notion Phase 1: + Add new → Doc now
                // navigates to the personal docs landing (no workspace
                // selection required). The landing page's own "+ New doc"
                // button creates the empty doc.
                onCreateDoc={() => {
                  navigate('/docs');
                }}
              />
            </div>
          )}
        </div>

        {/* === FIXED BOTTOM: User Footer === */}
        <div className="flex-shrink-0 border-t border-sidebar-border px-3 py-2.5">
          <button
            onClick={openProfileModal}
            className="flex items-center gap-2.5 w-full rounded-md px-1.5 py-1 hover:bg-sidebar-hover transition-all duration-150"
            title={t('sidebar.accountSettings')}
          >
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#0073ea] to-[#00a0f5] flex items-center justify-center text-white text-[10px] font-semibold flex-shrink-0">
              {user?.name?.charAt(0)?.toUpperCase() || 'U'}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-sidebar-text-active text-[11px] font-medium truncate">{user?.name}</p>
              <p className="text-sidebar-text/50 text-[9px]">{user ? tierLabel(resolveTier(user)) : ''}</p>
            </div>
            <Settings size={13} className="text-sidebar-text/30 flex-shrink-0" />
          </button>
        </div>

        </>)}
        {/* Resize Handle — only meaningful when expanded */}
        {!collapsed && (
          <div onMouseDown={handleMouseDown}
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-sidebar-accent/20 transition-colors z-10" />
        )}
      </div>

      {/* Workspace 3-dot menu */}
      <WorkspaceMenu
        anchorRef={wsMenuBtnRef}
        open={wsMenuOpen}
        onClose={() => setWsMenuOpen(false)}
        onNavigate={(path) => navigate(path)}
        onAddWorkspace={() => setShowCreateWorkspace(true)}
        onRearrangeWorkspaces={() => setShowRearrangeWorkspaces(true)}
        onBrowseAllWorkspaces={() => setShowBrowseAllWorkspaces(true)}
        canCreateWorkspace={canUser(user?.role, 'create_workspace', isSuperAdmin, permissionGrants, effectivePermissions)}
        canManage={canManage}
        hasMultipleWorkspaces={workspaces.length > 1}
      />

      {/* Phase 1: Browse-all-workspaces modal. Cards navigate to the new
          /workspaces/:id landing page; the modal closes on selection.
          "Create workspace" inside the modal reuses the existing
          CreateWorkspaceModal flow. */}
      <BrowseAllWorkspacesModal
        isOpen={showBrowseAllWorkspaces}
        onClose={() => setShowBrowseAllWorkspaces(false)}
        onCreateWorkspace={() => { setShowBrowseAllWorkspaces(false); setShowCreateWorkspace(true); }}
      />

      {/* Create Workspace Modal — usedColors is the set of colours already
          assigned to workspaces this user can see, so the modal's colour
          picker can default to a not-yet-used swatch (mirrors the Create
          Board behaviour). Empty array → random across the full palette. */}
      {showCreateWorkspace && (
        <CreateWorkspaceModal
          onClose={() => setShowCreateWorkspace(false)}
          onCreated={() => { loadData(); setShowCreateWorkspace(false); }}
          usedColors={workspaces.map(w => w.color).filter(Boolean)}
        />
      )}

      {/* Create Board Modal */}
      {showCreateBoard && (() => {
        // When opened from a workspace dropdown, bias the random color picker
        // to avoid colors already used by boards in that same workspace and
        // pin the modal to that workspace. When opened from the bottom button
        // with no inferred workspace, hand the modal the full workspace list
        // so the user must pick one.
        const ws = boardCreationWorkspace;
        const usedColors = ws
          ? (workspaces.find(w => w.id === ws.id)?.boards || []).map(b => b.color).filter(Boolean)
          : [];
        return (
          <CreateBoardModal
            isOpen={showCreateBoard}
            onClose={() => { setShowCreateBoard(false); setBoardCreationWorkspace(null); }}
            onSubmit={handleCreateBoard}
            workspaceId={ws?.id || null}
            workspaceName={ws?.name || ''}
            usedColors={usedColors}
            availableWorkspaces={ws ? [] : workspaces}
          />
        );
      })()}

      {/* Rearrange Boards Modal */}
      {rearrangeWorkspace && (
        <RearrangeBoardsModal
          workspace={rearrangeWorkspace}
          boards={applyUserOrder(rearrangeWorkspace.id, rearrangeWorkspace.boards || [])}
          onClose={() => setRearrangeWorkspace(null)}
          onSaved={(boardIds) => {
            // Optimistic local update so the sidebar reflects the new order
            // immediately, before the next loadData() fetches the server view.
            setBoardOrders(prev => ({ ...prev, [rearrangeWorkspace.id]: boardIds }));
            setRearrangeWorkspace(null);
            loadData();
          }}
        />
      )}

      {/* Rearrange Workspaces Modal — fed the workspace list pre-sorted so
          the modal opens already matching the order the user sees in the
          sidebar (pinned first, then saved manual order, then recency). */}
      {showRearrangeWorkspaces && (() => {
        const orderIdx = new Map((workspaceOrder || []).map((id, i) => [id, i]));
        const sorted = [...workspaces].sort((a, b) => {
          const ea = wsUsage[a.id] || {};
          const eb = wsUsage[b.id] || {};
          if (!!ea.pinned !== !!eb.pinned) return ea.pinned ? -1 : 1;
          const ai = orderIdx.has(a.id) ? orderIdx.get(a.id) : Infinity;
          const bi = orderIdx.has(b.id) ? orderIdx.get(b.id) : Infinity;
          if (ai !== bi) return ai - bi;
          return workspaceScore(eb) - workspaceScore(ea);
        });
        return (
          <RearrangeWorkspacesModal
            workspaces={sorted}
            onClose={() => setShowRearrangeWorkspaces(false)}
            onSaved={(workspaceIds) => {
              // Optimistic local update — the sidebar re-renders immediately
              // using the new order before loadData() refreshes from the API.
              setWorkspaceOrder(workspaceIds);
              setShowRearrangeWorkspaces(false);
              loadData();
            }}
          />
        );
      })()}

      {/* Profile is rendered by ProfileModalRoute (mounted in App.jsx) when
          we navigate to /profile with state.background — see openProfileModal
          above. The Header dropdown uses the same pattern, so both entry
          points open the identical bottom-sheet modal. */}
    </>
  );
}
