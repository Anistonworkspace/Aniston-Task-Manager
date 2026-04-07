import React from 'react';
import { ListTodo } from 'lucide-react';
import Avatar from '../common/Avatar';

export default function BoardCard({ board, onClick }) {
  const members = board.members || board.Users || [];
  const display = members.slice(0, 3);
  const overflow = members.length - 3;

  return (
    <div onClick={onClick} className="bg-white rounded-lg border border-border hover:border-primary/30 hover:shadow-md transition-all cursor-pointer group overflow-hidden">
      <div className="h-1.5" style={{ backgroundColor: board.color || '#0073ea' }} />
      <div className="p-4">
        <h3 className="text-sm font-semibold text-text-primary mb-1 group-hover:text-primary transition-colors truncate">{board.name}</h3>
        {board.description && <p className="text-xs text-text-secondary line-clamp-2 mb-3">{board.description}</p>}
        <div className="flex items-center justify-between mt-3">
          <div className="flex items-center -space-x-1.5">
            {display.map((m, i) => <Avatar key={m.id || i} name={m.name || m.user?.name} size="xs" className="ring-2 ring-white" />)}
            {overflow > 0 && <span className="text-[10px] text-text-secondary ml-2">+{overflow}</span>}
          </div>
          <div className="flex items-center gap-1 text-xs text-text-secondary">
            <ListTodo size={13} /> {board.taskCount ?? 0}
          </div>
        </div>
      </div>
    </div>
  );
}
