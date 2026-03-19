import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, LayoutGrid, List } from 'lucide-react';
import api from '../services/api';
import BoardCard from '../components/board/BoardCard';
import CreateBoardModal from '../components/board/CreateBoardModal';

export default function BoardsPage() {
  const navigate = useNavigate();
  const [boards, setBoards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [viewMode, setViewMode] = useState('grid');

  useEffect(() => { loadBoards(); }, []);

  async function loadBoards() {
    try {
      const res = await api.get('/boards');
      setBoards(res.data.boards || res.data || []);
    } catch (err) {
      console.error('Failed to load boards:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateBoard(data) {
    const res = await api.post('/boards', data);
    const newBoard = res.data.board || res.data;
    setBoards(prev => [...prev, newBoard]);
    setShowCreate(false);
    navigate(`/boards/${newBoard.id}`);
  }

  const filtered = searchQuery
    ? boards.filter(b => b.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : boards;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Boards</h1>
          <p className="text-sm text-text-secondary mt-0.5">Manage all your project boards</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-md transition-colors">
          <Plus size={16} /> New Board
        </button>
      </div>

      <div className="flex items-center gap-3 mb-5">
        <div className="flex items-center gap-2 bg-white border border-border rounded-md px-3 py-1.5 flex-1 max-w-[320px]">
          <Search size={14} className="text-text-secondary" />
          <input type="text" placeholder="Search boards..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            className="bg-transparent border-none outline-none text-sm w-full" />
        </div>
        <div className="flex items-center border border-border rounded-md overflow-hidden">
          <button onClick={() => setViewMode('grid')} className={`p-1.5 ${viewMode === 'grid' ? 'bg-primary text-white' : 'bg-white text-text-secondary hover:bg-surface'}`}><LayoutGrid size={16} /></button>
          <button onClick={() => setViewMode('list')} className={`p-1.5 ${viewMode === 'list' ? 'bg-primary text-white' : 'bg-white text-text-secondary hover:bg-surface'}`}><List size={16} /></button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-2 border-primary/20 border-t-primary" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4"><LayoutGrid size={28} className="text-primary" /></div>
          <h3 className="text-lg font-semibold mb-1">{searchQuery ? 'No boards found' : 'No boards yet'}</h3>
          <p className="text-sm text-text-secondary mb-4">{searchQuery ? 'Try a different search' : 'Create your first board to get started'}</p>
          {!searchQuery && <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-primary text-white text-sm rounded-md font-medium hover:bg-primary-hover"><Plus size={14} className="inline mr-1" /> Create Board</button>}
        </div>
      ) : (
        <div className={viewMode === 'grid' ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4' : 'flex flex-col gap-2'}>
          {filtered.map(board => (
            <BoardCard key={board.id} board={board} onClick={() => navigate(`/boards/${board.id}`)} />
          ))}
        </div>
      )}

      <CreateBoardModal isOpen={showCreate} onClose={() => setShowCreate(false)} onSubmit={handleCreateBoard} />
    </div>
  );
}
