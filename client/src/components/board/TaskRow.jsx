import React from 'react';
import { motion } from 'framer-motion';
import { GripVertical, ListChecks, MessageSquare, HelpCircle, Archive } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import StatusCell from './StatusCell';
import PriorityCell from './PriorityCell';
import PersonCell from './PersonCell';
import DateCell from './DateCell';
import ProgressCell from './ProgressCell';
import LabelCell from './LabelCell';
import TextCell from './TextCell';
import NumberCell from './NumberCell';
import CheckboxCell from './CheckboxCell';
import LinkCell from './LinkCell';
import TaskReceiptIcon from '../common/TaskReceiptIcon';

const TaskRow = React.memo(function TaskRow({
  task, members = [], color, columns = [], boardId,
  taskColWidth = 300, boardStatuses,
  onClick, onUpdate, onArchive, onRequestExtension, onRequestHelp,
  dragHandleProps, selected = false, onSelect,
}) {
  const subtaskTotal = task.subtaskTotal || task._subtaskCounts?.total || 0;
  const subtaskDone = task.subtaskDone || task._subtaskCounts?.done || 0;
  const isOverdue = task.dueDate && new Date(task.dueDate) < new Date() && task.status !== 'done';
  const daysOverdue = isOverdue ? Math.ceil((new Date() - new Date(task.dueDate)) / (1000 * 60 * 60 * 24)) : 0;

  const { user, isManager, isAdmin, isAssistantManager } = useAuth();
  const isApproved = task.approvalStatus === 'approved';

  // Row background: selected wins over overdue wins over default. Overdue uses
  // a solid subtle red tint (not alpha) so text stays readable and the sticky
  // task-title column inherits an opaque color instead of a washed-out one.
  const rowBg = selected
    ? 'bg-[#e6f0ff] hover:bg-[#dbeaff]'
    : isOverdue
      ? 'bg-[#fff5f6] hover:bg-[#ffeaee]'
      : 'bg-white hover:bg-[#f5f6f8]';
  // Strict RBAC: Only Admin/Manager/AssistantManager can edit all fields. Members restricted.
  const canEditAllFields = !isApproved && (isAdmin || isAssistantManager || (isManager && !!task.creator && task.creator.role !== 'admin'));
  const isBlockedByDependency = !!task.customFields?.blockedByDependency;
  const canEditStatus = !isApproved && !isBlockedByDependency;

  // Custom-column cell editability mirrors the backend allowlist in
  // server/middleware/taskPermissions.js (`edit` action → customFields).
  // Management roles can always edit; otherwise the caller must be the
  // assignee, creator, or appear in taskAssignees for this task.
  const isOwnTask = !!user?.id && (
    task.assignedTo === user.id ||
    task.createdBy === user.id ||
    (Array.isArray(task.taskAssignees) && task.taskAssignees.some(ta => ta.userId === user.id))
  );
  const canEditCustomFields = !isApproved && (canEditAllFields || isOwnTask);

  function renderCell(col) {
    const customVal = task.customFields?.[col.id];
    const customOnChange = canEditCustomFields
      ? val => onUpdate({ customFields: { ...task.customFields, [col.id]: val } })
      : undefined;
    switch (col.type) {
      case 'status': return <StatusCell value={task.status} onChange={canEditStatus ? (val => onUpdate({ status: val })) : undefined} taskStatuses={task.statusConfig} boardStatuses={boardStatuses} onSaveTaskStatuses={canEditAllFields ? (cfg => onUpdate({ statusConfig: cfg })) : undefined} canConfigureStatuses={canEditAllFields} approvalStatus={task.approvalStatus} isBlocked={isBlockedByDependency} />;
      case 'person': return <PersonCell value={task.assignedTo || task.assignee} owners={task.owners || []} members={members} taskAssignees={task.taskAssignees || []} onChange={canEditAllFields ? (val => onUpdate({ assignedTo: val })) : undefined} onOwnersChange={canEditAllFields ? (ids => onUpdate({ ownerIds: ids })) : undefined} />;
      case 'date': return <DateCell value={task.dueDate} onChange={canEditAllFields ? (val => onUpdate({ dueDate: val })) : undefined} taskId={task.id} assignedTo={task.assignedTo} estimatedHours={task.estimatedHours} />;
      case 'priority': return <PriorityCell value={task.priority} onChange={canEditAllFields ? (val => onUpdate({ priority: val })) : undefined} />;
      case 'progress': return <ProgressCell value={task.progress || 0} onChange={!isApproved ? (val => onUpdate({ progress: val })) : undefined} />;
      case 'label': return <LabelCell taskId={task.id} boardId={boardId} labels={task.labels || task.taskLabels || []} />;
      case 'text': return <TextCell value={customVal || ''} onChange={customOnChange} />;
      case 'number': return <NumberCell value={customVal} onChange={customOnChange} />;
      case 'checkbox': return <CheckboxCell value={customVal || false} onChange={customOnChange} />;
      case 'link': return <LinkCell value={customVal || ''} onChange={customOnChange} />;
      default: return <TextCell value={customVal || ''} onChange={customOnChange} />;
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={`flex items-stretch border-b border-[#e6e9ef] cursor-pointer transition-all duration-150 group/row ${rowBg}`}
      onClick={onClick}>

      {/* Sticky left: color bar + checkbox + task name */}
      <div className="flex items-stretch sticky left-0 z-[3] bg-inherit">
        {/* Color bar */}
        <div className="w-[6px] flex-shrink-0 self-stretch" style={{ backgroundColor: color, opacity: 0.6 }} />

        {/* Checkbox / drag handle */}
        <div className="w-10 flex-shrink-0 flex items-center justify-center">
          {dragHandleProps ? (
            <div {...dragHandleProps} className="p-0.5 cursor-grab active:cursor-grabbing text-[#c4c4c4] hover:text-[#676879] opacity-0 group-hover/row:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
              <GripVertical size={14} />
            </div>
          ) : (
            <input type="checkbox" checked={selected} onChange={e => { e.stopPropagation(); onSelect?.(!selected); }}
              className="w-4 h-4 rounded border-[#c4c4c4] text-[#0073ea] focus:ring-[#0073ea]/20 cursor-pointer" onClick={e => e.stopPropagation()} />
          )}
        </div>

        {/* Task Name — Monday.com style */}
        <div style={{ width: taskColWidth }} className="flex-shrink-0 px-3 py-2.5 text-[14px] text-[#323338] border-r border-[#e6e9ef] flex items-center gap-2">
          {/* WhatsApp-style receipt: renders only for the task assigner (the
              server only attaches _receipt for the creator/assigner). */}
          {task._receipt ? <TaskReceiptIcon receipt={task._receipt} /> : null}
          <span className="truncate flex-1">{task.title}</span>
          <div className="flex items-center gap-1 flex-shrink-0 text-[#c4c4c4]">
            {subtaskTotal > 0 && (
              <span className="flex items-center gap-0.5 text-[11px]" title={`${subtaskDone}/${subtaskTotal}`}>
                <ListChecks size={12} className={subtaskDone === subtaskTotal ? 'text-[#00c875]' : ''} />
              </span>
            )}
            {isOverdue && daysOverdue > 3 && (
              <span className="text-[10px] font-semibold text-[#e2445c] bg-[#fde8ec] px-1.5 py-0.5 rounded">{daysOverdue}d</span>
            )}
          </div>
        </div>
      </div>

      {/* Scrollable columns */}
      {columns.map(col => (
        <div key={col.id} className="flex-shrink-0 border-r border-[#e6e9ef] flex items-center justify-center"
          style={{ width: col.width || 140 }} onClick={e => e.stopPropagation()}>
          {renderCell(col)}
        </div>
      ))}

      {/* Hover actions */}
      <div className="w-[50px] flex-shrink-0 flex items-center justify-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity">
        {onRequestHelp && (
          <button onClick={e => { e.stopPropagation(); onRequestHelp(task); }}
            className="p-1 rounded hover:bg-[#cce5ff] text-[#676879] transition-colors" title="Help"><HelpCircle size={12} /></button>
        )}
        {onArchive && (
          <button onClick={e => { e.stopPropagation(); onArchive(task.id); }}
            className="p-1 rounded hover:bg-gray-100 text-[#c4c4c4] hover:text-[#676879] transition-colors" title="Archive"><Archive size={12} /></button>
        )}
      </div>
    </motion.div>
  );
});

export default TaskRow;
