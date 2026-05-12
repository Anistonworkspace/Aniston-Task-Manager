import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { GripVertical, MessageSquare, Archive, RefreshCw, ChevronRight, ChevronDown, BellRing, Link2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { canArchiveTask, canSetPriorityForTask, canEditDueDate } from '../../utils/permissions';
import StatusCell from './StatusCell';
import MarkDoneApprovalModal from '../task/MarkDoneApprovalModal';
import ApprovalStepIndicator from './ApprovalStepIndicator';
import PriorityCell from './PriorityCell';
import PersonCell from './PersonCell';
import DateCell from './DateCell';
import ProgressCell from './ProgressCell';
import LabelCell from './LabelCell';
import TextCell from './TextCell';
import NumberCell from './NumberCell';
import CheckboxCell from './CheckboxCell';
import LinkCell from './LinkCell';
import ReferenceCell from './ReferenceCell';
import LinksCell from './LinksCell';
import SubtaskCountBadge from './SubtaskCountBadge';
import TaskReceiptIcon from '../common/TaskReceiptIcon';

/**
 * Format the alarm-icon hover tooltip. Compact and human-friendly.
 *
 *   single reminder, soon  → "Reminder: 2:30 PM today"
 *   single reminder, far   → "Reminder: May 14, 3:30 PM"
 *   multiple reminders     → "3 reminders set — next May 14, 3:30 PM"
 *
 * Falls back to a generic label if the server hasn't attached
 * `nextReminderAt` (rare; means an enrichment error).
 */
function reminderTooltip(task) {
  if (!task) return 'Reminder set';
  const count = Number(task.activeReminderCount || 0);
  const nextAt = task.nextReminderAt ? new Date(task.nextReminderAt) : null;
  const isValid = nextAt && !Number.isNaN(nextAt.getTime());
  let timeLabel = '';
  if (isValid) {
    const today = new Date();
    const sameDay = nextAt.toDateString() === today.toDateString();
    timeLabel = sameDay
      ? nextAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : nextAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  if (count > 1) return `${count} reminders set${timeLabel ? ` — next ${timeLabel}` : ''}`;
  return timeLabel ? `Reminder: ${timeLabel}` : 'Reminder set';
}

const TaskRow = React.memo(function TaskRow({
  task, members = [], color, columns = [], boardId,
  taskColWidth = 300, boardStatuses,
  onClick, onUpdate, onArchive, onRequestExtension,
  dragHandleProps, selected = false, onSelect,
  // Inline-subtask controls — when provided, the row renders a chevron to
  // the left of the title that toggles the parent group's expanded set.
  // `expanded` reflects the current open/closed state for THIS task.
  expanded = false, onToggleSubtasks,
}) {
  const subtaskTotal = task.subtaskTotal || task._subtaskCounts?.total || 0;
  const subtaskDone = task.subtaskDone || task._subtaskCounts?.done || 0;
  const isOverdue = task.dueDate && new Date(task.dueDate) < new Date() && task.status !== 'done';
  const daysOverdue = isOverdue ? Math.ceil((new Date() - new Date(task.dueDate)) / (1000 * 60 * 60 * 24)) : 0;

  const { user, isTier1, isTier2, isSuperAdmin, granularPermissions } = useAuth();
  const isApproved = task.approvalStatus === 'approved';

  // True if the actor cannot assign tasks to OTHERS (default for members; also
  // true for managers/asst-mgrs that have an admin DENY on tasks.assign_others).
  // Backend remains the source of truth — this just hides invalid options.
  const canAssignOthers = isSuperAdmin || !!granularPermissions?.['tasks.assign_others'];

  // Priority is gated by its own granular action (`tasks.set_priority`).
  // Members default to false; managers/admins/asst-mgrs default to true.
  // Centralized per-task helper so a Tier 4 actor can still set priority on
  // tasks they CREATED and SOLELY OWN (mirrors the backend self-owned
  // exemption in updateTask/bulkUpdate/createTask). An explicit DENY on
  // the user still wins over the role default for the global path.
  const canSetPriority = canSetPriorityForTask(user, task, isSuperAdmin, granularPermissions);

  // Centralized archive check — respects role defaults, ownership for members,
  // and explicit DENY overrides. Hides the row's archive icon entirely when
  // the user can't archive this task, instead of showing a button that 403s.
  const canArchive = canArchiveTask(user, task, granularPermissions);

  // Row background: selected wins over overdue wins over default. Overdue uses
  // a solid subtle red tint (not alpha) so text stays readable and the sticky
  // task-title column inherits an opaque color instead of a washed-out one.
  const rowBg = selected
    ? 'bg-[#e6f0ff] hover:bg-[#dbeaff] dark:bg-[#1a2942] dark:hover:bg-[#1f3253]'
    : isOverdue
      ? 'bg-[#fff5f6] hover:bg-[#ffeaee] dark:bg-[#352024] dark:hover:bg-[#3f2730]'
      : 'bg-white hover:bg-[#f5f6f8]';
  // Tier-based RBAC: only Tier 1 / Tier 2 get unrestricted "edit all fields"
  // power. Tier 3 / Tier 4 fall through to the per-task ownership path
  // (`isOwnTask` below), matching the backend `checkTaskAction('edit')`
  // gate. The earlier `(isManager && task.creator.role !== 'admin')` clause
  // was a stale role-string check from before the tier migration; it was
  // also redundant because `isAdmin` (now Tier1||Tier2 in AuthContext) already
  // covered the manager case unconditionally. Removed for clarity and to
  // stop accidentally re-promoting Tier 3 to full edit.
  const canEditAllFields = !isApproved && (isTier1 || isTier2);
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

  // Bottom-sheet approval modal — opens when an assignee marks their own task
  // 'done' to collect a comment + optional attachment before submitting.
  const [showApprovalModal, setShowApprovalModal] = useState(false);

  // Intercept rule: when the actor owns the task and it isn't already
  // approved, a "Done" pick triggers the approval modal instead of a direct
  // status update. Self-assigned tasks are NOT exempt — the prior carve-out
  // for `isSelfTask` was the bypass that let members close their own work
  // without review. The chain service routes a self-task through the normal
  // hierarchy walk and auto-approves only when no senior reviewer exists.
  //
  // Super Admin exemption: Super Admins are the top of the org hierarchy
  // and have final authority on every task — they never go through approval.
  // Mirrors the backend gate in approvalController.submitForApproval and
  // approvalGateForCompletion in taskController.
  const shouldInterceptDone = (val) =>
    val === 'done'
    && isOwnTask
    && !isSuperAdmin
    && task.approvalStatus !== 'pending_approval'
    && task.approvalStatus !== 'approved';

  const handleStatusChange = (val) => {
    // Soft block: a non-super-admin owner clicking Done while a chain is
    // already pending should not re-trigger submission or fall through to a
    // direct status save (the backend would 403 anyway). The pill stays at
    // its prior value because BoardPage.handleTaskUpdate only commits on
    // success, so no revert is needed here.
    if (val === 'done' && !isSuperAdmin && task.approvalStatus === 'pending_approval') {
      return;
    }
    if (shouldInterceptDone(val)) {
      setShowApprovalModal(true);
      return;
    }
    onUpdate(val === 'done' ? { status: val, progress: 100 } : { status: val });
  };

  function renderCell(col) {
    const customVal = task.customFields?.[col.id];
    const customOnChange = canEditCustomFields
      ? val => onUpdate({ customFields: { ...task.customFields, [col.id]: val } })
      : undefined;
    switch (col.type) {
      case 'status': return (
        <div className="flex items-center gap-1.5 w-full">
          <StatusCell value={task.status} onChange={canEditStatus ? handleStatusChange : undefined} taskStatuses={task.statusConfig} boardStatuses={boardStatuses} onSaveTaskStatuses={canEditAllFields ? (cfg => onUpdate({ statusConfig: cfg })) : undefined} canConfigureStatuses={canEditAllFields} approvalStatus={task.approvalStatus} isBlocked={isBlockedByDependency} />
          {/* Approval pip indicator — only renders if the task has any chain rows.
              Rendered next to the Status pill (NOT replacing it) per the
              no-DONE-replacement rule from project setup. */}
          <ApprovalStepIndicator flows={task.approvalFlows} approvalStatus={task.approvalStatus} />
        </div>
      );
      case 'person': {
        // The picker is editable when:
        //   - the actor has full edit on this task (admin/manager/asst-mgr), OR
        //   - the actor owns the task (so a member can self-assign).
        const personEditable = canEditAllFields || isOwnTask;
        // If the actor can't assign others, lock the picker to current user.
        const lockToSelf = !canAssignOthers;
        return (
          <PersonCell
            value={task.assignedTo || task.assignee}
            owners={task.owners || []}
            members={members}
            taskAssignees={task.taskAssignees || []}
            dueDate={task.dueDate}
            onChange={personEditable ? (val => onUpdate({ assignedTo: val })) : undefined}
            onOwnersChange={personEditable ? (ids => onUpdate({ ownerIds: ids })) : undefined}
            assignSelfOnly={lockToSelf}
            currentUserId={user?.id}
            assigneeFallback={task.assignee || null}
          />
        );
      }
      case 'date': {
        // Due date editability layers two gates:
        //   1. Base "can touch dueDate at all" — Tier 1/2 always; Tier 3/4
        //      only if they are personally on the task (assignee/creator).
        //   2. Due-date lock — once a dueDate is set on a task, only Tier 1/2
        //      may change it. Tier 3/4 may still set the INITIAL value
        //      (existing dueDate is null), e.g. on a self-assigned quick-add.
        //      Mirrors the backend DUE_DATE_LOCKED gate in updateTask.
        // When the picker is locked, we render the date as read-only with a
        // tooltip — never hidden, since lower tiers must still SEE the date.
        const baseEditable = !isApproved && (canEditAllFields || isOwnTask);
        const dueDateAllowed = canEditDueDate(user, task);
        const dateEditable = baseEditable && dueDateAllowed;
        const lockedReason = baseEditable && !dueDateAllowed
          ? 'Only Tier 1 or Tier 2 can change this due date.'
          : undefined;
        return <DateCell value={task.dueDate} onChange={dateEditable ? (val => onUpdate({ dueDate: val })) : undefined} taskId={task.id} assignedTo={task.assignedTo} estimatedHours={task.estimatedHours} lockedReason={lockedReason} />;
      }
      case 'priority': {
        // Priority editing requires BOTH general edit access on this task AND
        // the dedicated set_priority permission. Members lacking set_priority
        // see the pill as a non-interactive label — no dropdown, no API call.
        const priorityEditable = !isApproved && canSetPriority && (canEditAllFields || isOwnTask);
        return <PriorityCell value={task.priority} onChange={priorityEditable ? (val => onUpdate({ priority: val })) : undefined} />;
      }
      case 'progress': {
        // Approval-required gate (UX mirror of the backend approvalGateForCompletion).
        // For non-super-admin owners on a not-yet-approved task, the slider
        // must not be draggable to 100% — the backend would reject it and the
        // user would see a confusing 403 toast. Approved tasks (chain
        // completed) and super admins keep the full 0-100 range.
        const progressApprovalRequired =
          isOwnTask && !isSuperAdmin && task.approvalStatus !== 'approved';
        return <ProgressCell value={task.progress || 0} status={task.status} approvalRequired={progressApprovalRequired} onChange={!isApproved ? (val => onUpdate({ progress: val })) : undefined} />;
      }
      // P3-4: removed `task.taskLabels` fallback — no endpoint populates
      // it. `task.labels` (from the canonical Label include) is the only
      // source of truth.
      // Labels are task metadata, not a board-management surface. Any user
      // who can see this row can add/remove labels; backend enforces
      // canViewTask on POST /api/labels and /labels/{assign,unassign} so a
      // hidden task is still blocked server-side. Passing canEdit={true}
      // is intentional — gating this on `canEditAllFields` previously
      // hid the Labels column entirely for Tier 3 + Tier 4 even on tasks
      // they owned, which the May 12 RBAC ticket flagged as too strict.
      case 'label': return <LabelCell taskId={task.id} boardId={boardId} labels={task.labels || []} canEdit={true} />;
      case 'references': {
        // Multi-value reference column — backed by the task_references table
        // (NOT customFields). The cell handles its own POST/DELETE against
        // /api/task-references and emits a `task:references_updated` socket
        // event, which BoardPage listens to for cross-tab refresh. Edit
        // gate matches custom fields: Tier 1/2 plus assignee/creator on
        // lower tiers (mirrors the backend canEditTaskRefs gate).
        return (
          <ReferenceCell
            taskId={task.id}
            value={task.references || []}
            readOnly={!canEditCustomFields}
          />
        );
      }
      case 'links': {
        // Multi-value link column — backed by the task_links table. Same
        // self-saving pattern as ReferenceCell.
        return (
          <LinksCell
            taskId={task.id}
            value={task.taskLinks || []}
            readOnly={!canEditCustomFields}
          />
        );
      }
      case 'text': return <TextCell value={customVal || ''} onChange={customOnChange} />;
      case 'number': return <NumberCell value={customVal} onChange={customOnChange} />;
      case 'checkbox': return <CheckboxCell value={customVal || false} onChange={customOnChange} />;
      case 'link': return <LinkCell value={customVal || ''} onChange={customOnChange} />;
      default: return <TextCell value={customVal || ''} onChange={customOnChange} />;
    }
  }

  return (
    <>
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={`flex items-stretch border-b border-[#e6e9ef] cursor-pointer transition-all duration-150 group/row relative isolate ${rowBg}`}
      onClick={onClick}>

      {/* Sticky left: color bar + checkbox + task name.
          `relative isolate` on the row above creates a per-row stacking
          context, and z-[20] here keeps the frozen column above any
          absolutely-positioned decoration inside a scrolling cell (e.g.
          StatusCell's z-10 "approved" tick at -top-1 -right-1). Without
          this, that tick floated above the sticky title during horizontal
          scroll and bled through on the left side of the task name. */}
      <div className="flex items-stretch sticky left-0 z-[20] bg-inherit">
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
          {/* Subtask expand chevron — appears on hover when the row has no
              subtasks; stays visible when subtasks exist (so the count badge
              acts as the visual cue too). Keyboard accessible: Enter / Space
              activates. Stops propagation so the row click doesn't open the
              modal. */}
          {onToggleSubtasks && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleSubtasks(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggleSubtasks(); } }}
              className={`flex-shrink-0 -ml-1 w-4 h-4 flex items-center justify-center rounded text-[#9aa1ad] hover:bg-[#eef0f4] hover:text-[#0073ea] transition-all ${
                expanded || subtaskTotal > 0 ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'
              }`}
              aria-label={expanded ? 'Collapse subitems' : 'Expand subitems'}
              aria-expanded={expanded}
              title={expanded ? 'Hide subitems' : (subtaskTotal > 0 ? `Show ${subtaskTotal} subitem${subtaskTotal === 1 ? '' : 's'}` : 'Add subitem')}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
          {/* WhatsApp-style receipt: renders only for the task assigner (the
              server only attaches _receipt for the creator/assigner). */}
          {task._receipt ? <TaskReceiptIcon receipt={task._receipt} /> : null}
          <span className="truncate flex-1 min-w-0">{task.title}</span>
          {/* monday.com-style subtask count pill — sits immediately after the
              title text, before the trailing icon group. flex-shrink-0 keeps
              it visible even when the title is long enough to truncate. The
              count comes from `task.subtaskTotal` (server) which the inline
              subtask section keeps in sync via BoardPage's count syncer. */}
          <SubtaskCountBadge count={subtaskTotal} doneCount={subtaskDone} className="ml-1" />
          <div className="flex items-center gap-1 flex-shrink-0 text-[#c4c4c4]">
            {/* Phase 5b — alarm icon when the task has at least one active
                (unsent, uncancelled) reminder. Server attaches
                `hasActiveReminder` + `nextReminderAt` + `activeReminderCount`
                via getReminderSummaryBulk in /api/tasks?boardId=…, so this
                is a no-op render when the task has no reminders. The icon
                disappears automatically once the reminder fires (sentAt
                set), gets cancelled (task complete/archive/delete), or the
                user clears it from the modal — all of which flip
                `hasActiveReminder` server-side on the next list refresh. */}
            {task.hasActiveReminder && (
              <span
                className="flex items-center text-amber-600 dark:text-amber-400"
                title={reminderTooltip(task)}
                aria-label={reminderTooltip(task)}
              >
                <BellRing size={11} />
              </span>
            )}
            {/* Dependency indicator — renders when the task is gated by a
                dependency (`customFields.blockedByDependency`, set by
                dependencyService whenever an active dependency request or
                blocker exists). The chain-link icon is the canonical
                "linked task / dependency" glyph used throughout the
                dependency system (DependencyBadge, TaskModal "Add
                dependency" button). Click bubbles to the row's onClick so
                opening the icon opens the TaskModal, whose Dependencies
                section shows the full chain. The icon is decorative only
                — accessible labelling lives on the wrapping span so screen
                readers don't double-announce, and color is paired with a
                glyph so the signal is not color-only. */}
            {isBlockedByDependency && (
              <span
                className="flex items-center text-rose-600 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 px-1.5 py-0.5 rounded transition-colors hover:bg-rose-100 dark:hover:bg-rose-900/30"
                title="This task has dependencies — open to view"
                aria-label="This task has dependencies. Open the task to view dependency details."
              >
                <Link2 size={10} aria-hidden="true" />
              </span>
            )}
            {/* Daily Work / Recurring instance marker — small icon with tooltip; full badge text
                is in the modal header so we don't crowd the row. */}
            {task.isRecurringInstance && (
              <span
                className="flex items-center gap-0.5 text-[10px] font-semibold text-purple-600 dark:text-purple-300 bg-purple-50 dark:bg-purple-900/20 px-1.5 py-0.5 rounded"
                title={`Daily Work — ${task.occurrenceDate || task.dueDate}`}
              >
                <RefreshCw size={10} />
              </span>
            )}
            {isOverdue && daysOverdue > 3 && (
              <span className="text-[10px] font-semibold text-[#e2445c] bg-[#fde8ec] dark:text-[#fda4af] dark:bg-[#4a2330] px-1.5 py-0.5 rounded">{daysOverdue}d</span>
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

      {/* Hover actions — slot is fixed-width to keep the row geometry stable
          even when no actions are visible (avoids hover flicker / column
          jitter for member users without permissions). */}
      <div className="w-[50px] flex-shrink-0 flex items-center justify-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity">
        {onArchive && canArchive && (
          <button onClick={e => { e.stopPropagation(); onArchive(task.id); }}
            className="p-1 rounded hover:bg-gray-100 text-[#c4c4c4] hover:text-[#676879] transition-colors" title="Archive"><Archive size={12} /></button>
        )}
      </div>
    </motion.div>

    {showApprovalModal && (
      <MarkDoneApprovalModal
        task={task}
        onClose={() => setShowApprovalModal(false)}
        // The controller emits `task:updated` over the socket on submit, so the
        // parent BoardPage's socket listener picks up the new approvalStatus —
        // no client-side optimistic patch needed (and approvalStatus isn't a
        // PATCH-allowed field via /api/tasks anyway).
        onSubmitted={() => {}}
      />
    )}
    </>
  );
});

export default TaskRow;
