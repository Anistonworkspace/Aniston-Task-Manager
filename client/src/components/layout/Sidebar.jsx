import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Home, User, ChevronDown, ChevronRight, Plus, Search, MoreHorizontal,
  FolderKanban, Star, StarOff, BarChart3, Users, Clock, FileText, CalendarDays,
  Puzzle, Archive, Settings, Link2, GitBranch, PanelLeftClose, PanelLeft,
  Edit3, ArrowUpDown, LayoutGrid, LayoutDashboard, ClipboardCheck, Crown
} from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import useSocket from '../../hooks/useSocket';
import CreateWorkspaceModal from '../board/CreateWorkspaceModal';
import ProfileModal from '../common/ProfileModal';

// Portal-based dropdown that renders outside sidebar overflow
function WorkspaceMenu({ anchorRef, open, onClose, onNavigate, onAddWorkspace }) {
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
    <div ref={menuRef} className="fixed w-56 bg-white rounded-xl shadow-dropdown border border-border z-[100] dropdown-enter overflow-hidden py-1"
      style={{ top: pos.top, left: pos.left }}>
      <button onClick={() => { onClose(); onAddWorkspace(); }}
        className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
        <Plus size={14} strokeWidth={1.8} /> Add new workspace
      </button>
      <button onClick={() => { onClose(); onNavigate('/boards'); }}
        className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
        <LayoutGrid size={14} strokeWidth={1.8} /> Browse all boards
      </button>
      <button onClick={() => { onClose(); onNavigate('/archive'); }}
        className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary hover:bg-surface-50 w-full transition-colors">
        <Archive size={14} strokeWidth={1.8} /> View archive
      </button>
    </div>,
    document.body
  );
}

export default function Sidebar({ collapsed, onToggle }) {
  const { user, canManage, isAdmin, isManager, isDirector } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [boards, setBoards] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [openWorkspaces, setOpenWorkspaces] = useState({});
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [wsActionMenu, setWsActionMenu] = useState(null);
  const [renamingBoard, setRenamingBoard] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingWorkspace, setRenamingWorkspace] = useState(null);
  const [wsRenameValue, setWsRenameValue] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const resizing = useRef(false);
  const wsMenuBtnRef = useRef(null);
  const renameInputRef = useRef(null);

  useEffect(() => { loadData(); }, []);

  useSocket('board:created', () => loadData());
  useSocket('board:updated', () => loadData());
  useSocket('board:deleted', () => loadData());

  async function loadData() {
    try {
      const [boardsRes, wsRes] = await Promise.all([
        api.get('/boards'),
        api.get('/workspaces/mine'),
      ]);
      const allBoards = boardsRes.data.boards || boardsRes.data || [];
      setBoards(allBoards);
      setFavorites(JSON.parse(localStorage.getItem('favoriteBoards') || '[]'));

      const myWorkspaces = wsRes.data.workspaces || wsRes.data.data?.workspaces || [];
      setWorkspaces(myWorkspaces);

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

  const NavItem = ({ icon: Icon, label, path }) => (
    <button onClick={() => navigate(path)}
      className={`sidebar-item w-full ${isActive(path) ? 'sidebar-item-active' : ''}`}>
      <Icon size={16} strokeWidth={1.8} />
      <span className="flex-1 text-left truncate">{label}</span>
    </button>
  );

  function renderBoardItem(board) {
    return (
      <div key={board.id} className="group flex items-center">
        {renamingBoard === board.id ? (
          <div className="flex-1 px-2 py-1">
            <input ref={renameInputRef} type="text" value={renameValue} onChange={e => setRenameValue(e.target.value)}
              onBlur={() => saveRename(board.id)}
              onKeyDown={e => { if (e.key === 'Enter') saveRename(board.id); if (e.key === 'Escape') setRenamingBoard(null); }}
              className="w-full text-[13px] px-2 py-1 border border-sidebar-accent rounded-md outline-none bg-white text-sidebar-text-active" />
          </div>
        ) : (
          <>
            <button onClick={() => navigate(`/boards/${board.id}`)}
              className={`sidebar-item flex-1 text-[13px] ${isBoardActive(board.id) ? 'sidebar-item-active' : ''}`}>
              <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: board.color || '#579bfc' }} />
              <span className="truncate flex-1 text-left">{board.name}</span>
            </button>
            <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity mr-1">
              <button onClick={(e) => { e.stopPropagation(); startRename(board); }}
                className="p-0.5 rounded text-sidebar-text/30 hover:text-sidebar-accent transition-colors" title="Rename">
                <Edit3 size={11} />
              </button>
              <button onClick={(e) => toggleFavorite(e, board.id)}
                className="p-0.5 rounded text-sidebar-text/30 hover:text-amber-400 transition-colors" title="Favorite">
                {favorites.includes(board.id) ? <Star size={11} className="fill-amber-400 text-amber-400" /> : <StarOff size={11} />}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="w-[52px] bg-sidebar-bg flex flex-col items-center py-3 gap-1 flex-shrink-0 border-r border-sidebar-border max-md:hidden" style={{ transition: 'width 0.2s cubic-bezier(0.16, 1, 0.3, 1)' }}>
        <button onClick={onToggle} className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#0073ea] to-[#00a0f5] flex items-center justify-center mb-2 shadow-sm">
          <FolderKanban size={15} className="text-white" />
        </button>
        <div className="w-5 border-t border-sidebar-border my-1" />
        {[
          { icon: Home, path: '/', label: 'Home' },
          { icon: User, path: '/my-work', label: 'My Work' },
          { icon: Clock, path: '/time-plan', label: 'Time Plan' },
          { icon: CalendarDays, path: '/meetings', label: 'Meetings' },
        ].map(item => (
          <button key={item.path} onClick={() => navigate(item.path)}
            className={`p-2 rounded-md transition-all duration-150 ${isActive(item.path) ? 'bg-sidebar-active text-sidebar-accent' : 'text-sidebar-text hover:bg-sidebar-hover hover:text-sidebar-text-active'}`}
            title={item.label}>
            <item.icon size={18} strokeWidth={1.8} />
          </button>
        ))}
        {canManage && (
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
          <button onClick={() => setShowProfileModal(true)}
            className="w-7 h-7 rounded-full bg-gradient-to-br from-[#0073ea] to-[#00a0f5] flex items-center justify-center text-white text-[10px] font-semibold"
            title="Profile">
            {user?.name?.charAt(0)?.toUpperCase() || 'U'}
          </button>
        </div>
        {showProfileModal && <ProfileModal onClose={() => setShowProfileModal(false)} />}
      </div>
    );
  }

  return (
    <>
      {/* Mobile backdrop overlay */}
      <div
        className={`fixed inset-0 bg-black/40 z-40 md:hidden transition-opacity duration-200 ${collapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
        onClick={onToggle}
      />
      <div style={{ width: sidebarWidth, transition: resizing.current ? 'none' : 'width 0.2s cubic-bezier(0.16, 1, 0.3, 1)' }}
        className={`bg-sidebar-bg flex flex-col flex-shrink-0 h-full border-r border-sidebar-border relative select-none
          max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-2xl
          ${collapsed ? 'max-md:-translate-x-full' : 'max-md:translate-x-0'}
          max-md:transition-transform max-md:duration-200`}>

        {/* === FIXED TOP: Logo only === */}
        <div className="flex-shrink-0">
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-sidebar-border">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#0073ea] to-[#00a0f5] flex items-center justify-center shadow-sm flex-shrink-0">
              <FolderKanban size={14} className="text-white" />
            </div>
            <h1 className="text-sidebar-text-active text-[13px] font-bold truncate leading-tight flex-1">Aniston Hub</h1>
            <button onClick={onToggle} className="text-sidebar-text/50 hover:text-sidebar-text-active p-1 rounded-md hover:bg-sidebar-hover transition-all duration-150">
              <PanelLeftClose size={15} />
            </button>
          </div>
        </div>

        {/* === FULLY SCROLLABLE MIDDLE SECTION (nav + workspaces) === */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-sidebar">

          {/* Main Nav */}
          <nav className="py-2 flex flex-col gap-0.5">
            <NavItem icon={Home} label="Home" path="/" />
            <NavItem icon={User} label="My Work" path="/my-work" />
            <NavItem icon={LayoutDashboard} label="My Dashboard" path={isAdmin ? '/admin-dashboard' : isManager ? '/manager-dashboard' : '/member-dashboard'} />
            {isDirector && <NavItem icon={Crown} label="Director Dashboard" path="/director-dashboard" />}
            <NavItem icon={GitBranch} label="Org Chart" path="/org-chart" />
            <NavItem icon={Clock} label="Time Plan" path="/time-plan" />
            <NavItem icon={CalendarDays} label="Meetings" path="/meetings" />
            <NavItem icon={FileText} label="Reviews" path="/reviews" />
            <NavItem icon={ClipboardCheck} label="Tasks" path="/tasks" />
            <NavItem icon={Link2} label="Dependencies" path="/cross-team" />
          </nav>

          {canManage && (
            <>
              <div className="border-t border-sidebar-border mx-3 my-1" />
              <nav className="py-1 flex flex-col gap-0.5">
                <NavItem icon={BarChart3} label="Dashboard" path="/dashboard" />
                <NavItem icon={Users} label="Team" path="/users" />
              </nav>
            </>
          )}

          {isAdmin && (
            <>
              <div className="border-t border-sidebar-border mx-3 my-1" />
              <nav className="py-1 flex flex-col gap-0.5">
                <NavItem icon={Settings} label="Admin Settings" path="/admin-settings" />
                <NavItem icon={Puzzle} label="Integrations" path="/integrations" />
                <NavItem icon={Archive} label="Archive" path="/archive" />
              </nav>
            </>
          )}

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
          <div className="flex items-center justify-between px-5 py-1.5 mt-1">
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

          {/* Dynamic Workspaces */}
          <div className="px-2 pb-2 space-y-1">
            {workspaces.map(ws => {
              const wsBoards = (ws.boards || []).filter(b =>
                !searchQuery || b.name.toLowerCase().includes(searchQuery.toLowerCase())
              );
              const isOpen = openWorkspaces[ws.id] !== false;

              return (
                <div key={ws.id} className="group/ws relative">
                  <button
                    onClick={() => setOpenWorkspaces(prev => ({ ...prev, [ws.id]: !isOpen }))}
                    className="flex items-center gap-2 px-3 py-1.5 w-full hover:bg-sidebar-hover rounded-md transition-colors">
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
                    {ws.workspaceMembers?.length > 0 && (
                      <span className="text-[10px] text-sidebar-text/40 mr-1">{ws.workspaceMembers.length}</span>
                    )}
                    <ChevronDown size={13} className={`text-sidebar-text/40 transition-transform duration-150 flex-shrink-0 ${isOpen ? '' : '-rotate-90'}`} />
                  </button>
                  {/* Workspace hover menu */}
                  {canManage && (
                    <div className="absolute right-1 top-1 opacity-0 group-hover/ws:opacity-100 transition-opacity z-10">
                      <div className="relative">
                        <button onClick={(e) => { e.stopPropagation(); setWsActionMenu(wsActionMenu === ws.id ? null : ws.id); }}
                          className="p-1 rounded-md text-sidebar-text/30 hover:text-sidebar-text hover:bg-sidebar-hover transition-colors">
                          <MoreHorizontal size={13} />
                        </button>
                        {wsActionMenu === ws.id && (
                          <div className="absolute right-0 top-full mt-1 w-44 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50"
                            onMouseLeave={() => setWsActionMenu(null)}>
                            <button onClick={() => { setRenamingWorkspace(ws.id); setWsRenameValue(ws.name); setWsActionMenu(null); }}
                              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50">
                              <Edit3 size={12} /> Rename
                            </button>
                            <button onClick={() => { if (confirm(`Archive workspace "${ws.name}"? All boards inside will be hidden.`)) { api.put(`/workspaces/${ws.id}`, { isActive: false }).then(() => loadData()); } setWsActionMenu(null); }}
                              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-orange-600 hover:bg-orange-50">
                              <Archive size={12} /> Archive Workspace
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {isOpen && (
                    <div className="ml-4 mt-0.5 border-l border-sidebar-border pl-1 animate-fade-in">
                      {wsBoards.map(board => renderBoardItem(board))}
                      {wsBoards.length === 0 && searchQuery && (
                        <p className="text-sidebar-text/40 text-[11px] px-3 py-1.5">No boards match</p>
                      )}
                      {wsBoards.length === 0 && !searchQuery && (
                        <p className="text-sidebar-text/40 text-[11px] px-3 py-1.5">No boards yet</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Unassigned boards (not in any workspace) */}
            {filteredUnassigned.length > 0 && (
              <div>
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
          </div>

          {/* Add Workspace */}
          <div className="px-2 pb-4">
            <button onClick={() => setShowCreateWorkspace(true)}
              className="flex items-center gap-2 px-3 py-1.5 w-full text-sidebar-text/50 hover:text-sidebar-accent hover:bg-sidebar-hover rounded-md transition-colors text-[13px]">
              <Plus size={14} /> Add new workspace
            </button>
          </div>
        </div>

        {/* === FIXED BOTTOM: User Footer === */}
        <div className="flex-shrink-0 border-t border-sidebar-border px-3 py-2.5">
          <button
            onClick={() => setShowProfileModal(true)}
            className="flex items-center gap-2.5 w-full rounded-md px-1.5 py-1 hover:bg-sidebar-hover transition-all duration-150"
            title="Account Settings"
          >
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#0073ea] to-[#00a0f5] flex items-center justify-center text-white text-[10px] font-semibold flex-shrink-0">
              {user?.name?.charAt(0)?.toUpperCase() || 'U'}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-sidebar-text-active text-[11px] font-medium truncate">{user?.name}</p>
              <p className="text-sidebar-text/50 text-[9px] capitalize">{user?.role}</p>
            </div>
            <Settings size={13} className="text-sidebar-text/30 flex-shrink-0" />
          </button>
        </div>

        {/* Resize Handle */}
        <div onMouseDown={handleMouseDown}
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-sidebar-accent/20 transition-colors z-10" />
      </div>

      {/* Workspace 3-dot menu */}
      <WorkspaceMenu
        anchorRef={wsMenuBtnRef}
        open={wsMenuOpen}
        onClose={() => setWsMenuOpen(false)}
        onNavigate={(path) => navigate(path)}
        onAddWorkspace={() => setShowCreateWorkspace(true)}
      />

      {/* Create Workspace Modal */}
      {showCreateWorkspace && (
        <CreateWorkspaceModal
          onClose={() => setShowCreateWorkspace(false)}
          onCreated={() => { loadData(); setShowCreateWorkspace(false); }}
        />
      )}

      {/* Profile Modal (slide-over) */}
      {showProfileModal && (
        <ProfileModal onClose={() => setShowProfileModal(false)} />
      )}
    </>
  );
}
