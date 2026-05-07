import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Home, User, ChevronDown, ChevronRight, Plus, Search, MoreHorizontal,
  FolderKanban, Star, StarOff, BarChart3, Users, FileText, CalendarDays,
  Puzzle, Archive, Settings, PanelLeftClose, PanelLeft,
  Edit3, ArrowUpDown, LayoutGrid, LayoutDashboard, ClipboardCheck,
  RefreshCw, Pin, PinOff
} from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import useRealtimeQuery from '../../realtime/useRealtimeQuery';
import CreateWorkspaceModal from '../board/CreateWorkspaceModal';
import CreateBoardModal from '../board/CreateBoardModal';
import RearrangeBoardsModal from '../board/RearrangeBoardsModal';
import RearrangeWorkspacesModal from '../board/RearrangeWorkspacesModal';
import { canUser } from '../../utils/permissions';
import { resolveTier, tierLabel } from '../../utils/tiers';

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
function WorkspaceMenu({ anchorRef, open, onClose, onNavigate, onAddWorkspace, onRearrangeWorkspaces, canCreateWorkspace, canManage, hasMultipleWorkspaces }) {
  const menuRef = useRef(null);
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
    <div ref={menuRef} className="fixed w-56 bg-white dark:bg-[#1E1F23] rounded-xl shadow-dropdown border border-border z-[100] dropdown-enter overflow-hidden py-1"
      style={{ top: pos.top, left: pos.left }}>
      {canCreateWorkspace && (
        <button onClick={() => { onClose(); onAddWorkspace(); }}
          className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
          <Plus size={14} strokeWidth={1.8} /> Add new workspace
        </button>
      )}
      {/* Rearrange Workspaces — visible to every user since the saved order
          is a personal preference. The button is hidden when the user has
          fewer than two workspaces because there's nothing to reorder. */}
      {hasMultipleWorkspaces && (
        <button onClick={() => { onClose(); onRearrangeWorkspaces?.(); }}
          className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
          <ArrowUpDown size={14} strokeWidth={1.8} /> Rearrange Workspaces
        </button>
      )}
      <button onClick={() => { onClose(); onNavigate('/boards'); }}
        className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
        <LayoutGrid size={14} strokeWidth={1.8} /> Browse all boards
      </button>
      {canManage && (
        <button onClick={() => { onClose(); onNavigate('/admin-settings'); }}
          className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
          <Puzzle size={14} strokeWidth={1.8} /> Browse all workspaces
        </button>
      )}
      {canManage && (
        <button onClick={() => { onClose(); onNavigate('/archive'); }}
          className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
          <Archive size={14} strokeWidth={1.8} /> View archive
        </button>
      )}
    </div>,
    document.body
  );
}

export default function Sidebar({ collapsed, onToggle }) {
  const { user, canManage, isAdmin, isStrictAdmin, isManager, isAssistantManager, isDirector, isSuperAdmin, permissionGrants, effectivePermissions, granularPermissions } = useAuth();
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

  const NavItem = ({ icon: Icon, label, path, tourId }) => (
    <button onClick={() => navigate(path)}
      data-tour={tourId || undefined}
      className={`sidebar-item w-full ${isActive(path) ? 'sidebar-item-active' : ''}`}>
      <Icon size={16} strokeWidth={1.8} />
      <span className="flex-1 text-left truncate">{label}</span>
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
                <div className="absolute right-2 top-full mt-0.5 z-50 w-32 bg-white dark:bg-[#1E1F23] rounded-lg shadow-dropdown border border-border py-1 dropdown-enter">
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
        { icon: Home, path: '/', label: 'Home' },
        { icon: User, path: '/my-work', label: 'My Work' },
        { icon: CalendarDays, path: '/meetings', label: 'Meetings' },
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
            title="Dashboard">
            <BarChart3 size={18} strokeWidth={1.8} />
          </button>
        </>
      )}
      <div className="mt-auto">
        <button onClick={openProfileModal}
          className="w-7 h-7 rounded-full bg-gradient-to-br from-[#0073ea] to-[#00a0f5] flex items-center justify-center text-white text-[10px] font-semibold"
          title="Profile">
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
        className={`bg-sidebar-bg dark:bg-[#1A1B1F] flex flex-col flex-shrink-0 h-full border-r border-sidebar-border relative select-none overflow-hidden
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

          {/* Main Nav */}
          <nav className="py-2 flex flex-col gap-0.5">
            <NavItem icon={Home} label="Home" path="/" tourId="nav-home" />
            {!isSuperAdmin && <NavItem icon={User} label="My Work" path="/my-work" tourId="nav-mywork" />}
            <NavItem icon={LayoutDashboard} label="My Dashboard" path={isAdmin ? '/admin-dashboard' : isManager ? '/manager-dashboard' : '/member-dashboard'} tourId="nav-mydashboard" />
            {/* Org Chart and Time Plan moved to header icons (see Header.jsx). */}
            <NavItem icon={CalendarDays} label="Meetings" path="/meetings" tourId="nav-meetings" />
            <NavItem icon={FileText} label="Reviews" path="/reviews" tourId="nav-reviews" />
            <NavItem icon={ClipboardCheck} label="Tasks & Workflows" path="/tasks" tourId="nav-tasks" />
            <NavItem icon={RefreshCw} label="Recurring Work" path="/recurring-work" tourId="nav-recurring-work" />
          </nav>

          {(canManage || !!granularPermissions['dashboard.view']) && (
            <>
              <div className="border-t border-sidebar-border mx-3 my-1" />
              <nav className="py-1 flex flex-col gap-0.5">
                {(canManage || !!granularPermissions['dashboard.view']) && (
                  <NavItem icon={BarChart3} label="Dashboard" path="/dashboard" tourId="nav-dashboard" />
                )}
                {(canManage) && (
                  <NavItem icon={Users} label="Team" path="/users" />
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
                Favorites
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
            <span className="text-[11px] uppercase tracking-wide text-sidebar-text/60 font-semibold">Workspaces</span>
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
              <input type="text" placeholder="Search boards..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
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
            const collapse = !showAllWorkspaces && !searchQuery && sortedWorkspaces.length > WS_VISIBLE_LIMIT;
            let visibleWorkspaces = collapse ? sortedWorkspaces.slice(0, WS_VISIBLE_LIMIT) : sortedWorkspaces;
            if (collapse && activeWsId && !visibleWorkspaces.some(w => w.id === activeWsId)) {
              const ws = sortedWorkspaces.find(w => w.id === activeWsId);
              if (ws) visibleWorkspaces = [...visibleWorkspaces, ws];
            }
            const hiddenWsCount = Math.max(0, sortedWorkspaces.length - WS_VISIBLE_LIMIT);
            return (
          <div className="px-2 pb-2 space-y-1">
            {visibleWorkspaces.map(ws => {
              const wsBoardsRaw = (ws.boards || []).filter(b =>
                !searchQuery || b.name.toLowerCase().includes(searchQuery.toLowerCase())
              );
              // Apply per-user ordering before the show-more slicing kicks in
              // so the user's preference is respected at the top of the list.
              const wsBoards = applyUserOrder(ws.id, wsBoardsRaw);
              const isOpen = openWorkspaces[ws.id] !== false;

              return (
                <div key={ws.id}
                  onDragOver={(e) => { if (dragBoardId) { e.preventDefault(); setDragOverWsId(ws.id); } }}
                  onDragLeave={() => setDragOverWsId(null)}
                  onDrop={(e) => { e.preventDefault(); if (dragBoardId) { handleBoardDrop(dragBoardId, ws.id); setDragBoardId(null); setDragOverWsId(null); } }}
                  className={`group/ws relative transition-all ${dragOverWsId === ws.id ? 'bg-sidebar-hover ring-1 ring-sidebar-accent rounded-md' : ''}`}>
                  <button
                    onClick={() => setOpenWorkspaces(prev => ({ ...prev, [ws.id]: !isOpen }))}
                    className="flex items-center gap-2 pl-3 pr-7 py-1.5 w-full hover:bg-sidebar-hover rounded-md transition-colors">
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
                    <ChevronDown size={13} className={`text-sidebar-text/40 transition-transform duration-150 flex-shrink-0 ${isOpen ? '' : '-rotate-90'}`} />
                  </button>
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
                        <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-[#1E1F23] rounded-lg shadow-lg border border-border py-1 z-50"
                          onMouseLeave={() => setWsActionMenu(null)}>
                          {/* Personal pin — available to every role since it
                              only writes to localStorage. Pinned workspaces
                              float to the top of the sidebar list. */}
                          <button onClick={() => { toggleWorkspacePin(ws.id); setWsActionMenu(null); }}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-100">
                            {wsUsage[ws.id]?.pinned
                              ? <><PinOff size={12} /> Unpin from top</>
                              : <><Pin size={12} /> Pin to top</>
                            }
                          </button>
                          {canCreateBoardPerm && (
                            <button onClick={() => { setWsActionMenu(null); openCreateBoardForWorkspace(ws); }}
                              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-100">
                              <Plus size={12} /> Create Board
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
                            <ArrowUpDown size={12} /> Rearrange Boards
                          </button>
                          {canEditWsPerm && (
                            <button onClick={() => { setRenamingWorkspace(ws.id); setWsRenameValue(ws.name); setWsActionMenu(null); }}
                              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-100">
                              <Edit3 size={12} /> Rename
                            </button>
                          )}
                          {canEditWsPerm && (
                            <button onClick={() => { if (confirm(`Archive workspace "${ws.name}"? All boards inside will be hidden.`)) { api.put(`/workspaces/${ws.id}`, { isActive: false }).then(() => loadData()); } setWsActionMenu(null); }}
                              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-500/10">
                              <Archive size={12} /> Archive Workspace
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {isOpen && (() => {
                    // Per-workspace "show more / show less" — collapse to the
                    // first 3 boards by default, with a toggle to reveal the
                    // rest. The active board (if any) is always kept visible
                    // even when collapsed so the user never loses context.
                    const BOARD_LIMIT = 3;
                    const showAll = !!showAllByWorkspace[ws.id];
                    const hasMore = wsBoards.length > BOARD_LIMIT;
                    let visible = showAll || !hasMore ? wsBoards : wsBoards.slice(0, BOARD_LIMIT);
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
                        {wsBoards.length === 0 && searchQuery && (
                          <p className="text-sidebar-text/40 text-[11px] px-3 py-1.5">No boards match</p>
                        )}
                        {wsBoards.length === 0 && !searchQuery && (
                          <p className="text-sidebar-text/40 text-[11px] px-3 py-1.5">No boards yet</p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })}

            {/* Unassigned boards (not in any workspace) */}
            {filteredUnassigned.length > 0 && (
              <div
                onDragOver={(e) => { if (dragBoardId) { e.preventDefault(); setDragOverWsId('unassigned'); } }}
                onDragLeave={() => setDragOverWsId(null)}
                onDrop={(e) => { e.preventDefault(); if (dragBoardId) { handleBoardDrop(dragBoardId, null); setDragBoardId(null); setDragOverWsId(null); } }}
                className={`transition-all ${dragOverWsId === 'unassigned' ? 'bg-sidebar-hover ring-1 ring-sidebar-accent rounded-md' : ''}`}>
                {workspaces.length > 0 && (
                  <div className="px-3 py-1 mt-1">
                    <span className="text-[10px] uppercase tracking-wide text-sidebar-text/40">Other Boards</span>
                  </div>
                )}
                <div className="ml-4 border-l border-sidebar-border pl-1">
                  {filteredUnassigned.map(board => renderBoardItem(board))}
                </div>
              </div>
            )}

            {boards.length === 0 && workspaces.length === 0 && (
              <p className="text-sidebar-text/40 text-[11px] px-3 py-2">No boards yet</p>
            )}

            {/* Workspace-level Show More toggle. Only renders when more than
                WS_VISIBLE_LIMIT workspaces exist and the user isn't searching
                (search bypasses the cap so all hits are visible). */}
            {!searchQuery && sortedWorkspaces.length > WS_VISIBLE_LIMIT && (
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

          {/* Add Workspace — admin/super_admin only */}
          {canUser(user?.role, 'create_workspace', isSuperAdmin, permissionGrants, effectivePermissions) && (
            <div className="px-2 pb-1">
              <button onClick={() => setShowCreateWorkspace(true)}
                className="flex items-center gap-2 px-3 py-1.5 w-full text-sidebar-text/50 hover:text-sidebar-accent hover:bg-sidebar-hover rounded-md transition-colors text-[13px]">
                <Plus size={14} /> Add new workspace
              </button>
            </div>
          )}

          {/* Create Board — visible to anyone with create_board permission.
              The bottom button defaults to the workspace of the board the
              user is currently looking at (if any). When there is no inferred
              workspace, the modal forces the user to pick one. */}
          {canCreateBoardPerm && (
            <div className="px-2 pb-4">
              <button onClick={() => {
                  const inferredWsId = inferCurrentWorkspaceId();
                  const inferredWs = inferredWsId ? workspaces.find(w => w.id === inferredWsId) : null;
                  setBoardCreationWorkspace(inferredWs || null);
                  setShowCreateBoard(true);
                }}
                className="flex items-center gap-2 px-3 py-1.5 w-full text-sidebar-text/50 hover:text-sidebar-accent hover:bg-sidebar-hover rounded-md transition-colors text-[13px]">
                <FolderKanban size={14} /> Create new board
              </button>
            </div>
          )}
        </div>

        {/* === FIXED BOTTOM: User Footer === */}
        <div className="flex-shrink-0 border-t border-sidebar-border px-3 py-2.5">
          <button
            onClick={openProfileModal}
            className="flex items-center gap-2.5 w-full rounded-md px-1.5 py-1 hover:bg-sidebar-hover transition-all duration-150"
            title="Account Settings"
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
        canCreateWorkspace={canUser(user?.role, 'create_workspace', isSuperAdmin, permissionGrants, effectivePermissions)}
        canManage={canManage}
        hasMultipleWorkspaces={workspaces.length > 1}
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
