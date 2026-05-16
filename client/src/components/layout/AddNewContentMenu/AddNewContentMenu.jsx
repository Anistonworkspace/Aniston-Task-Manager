import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LayoutGrid, FileText, BarChart3, Sparkles, ClipboardList, Workflow, Folder,
  Briefcase, FolderKanban, ChevronRight,
} from 'lucide-react';
import Popover from '../../common/Popover';
import { useAuth } from '../../../context/AuthContext';
import { isExplicitlyDenied } from '../../../utils/permissions';

/**
 * AddNewContentMenu — the universal "+" Popover.
 *
 *   <AddNewContentMenu open onOpenChange={setOpen} anchorRef={btnRef} workspaceId={ws?.id}
 *     onCreateBoard={() => ...}
 *     onCreateWorkspace={() => ...}
 *     onOpenMagic={() => ...}
 *   />
 *
 * The menu is a render-only surface — actions are passed in by the consumer.
 * That keeps wiring decisions (route-vs-modal-vs-builder) at the call site
 * rather than baking them into the menu.
 *
 * Tier-gated items (Magic AI, Workflow, Folder, Form, Project, Portfolio) are
 * hidden when the user lacks permission — never disabled. Hiding is preferred
 * (see GENERAL §13 anti-patterns + skill §1.8) so the menu doesn't tease
 * features the user can't reach.
 */

export default function AddNewContentMenu({
  open,
  onOpenChange,
  trigger,
  placement = 'bottom-start',
  workspaceId,
  onCreateBoard,
  onCreateWorkspace,
  onCreateDoc,
  onCreateDashboard,
  onCreateForm,
  onCreateWorkflow,
  onCreateFolder,
  onCreateProject,
  onCreatePortfolio,
  onOpenMagic,
}) {
  const { isSuperAdmin, canManage, isStrictAdmin, granularPermissions } = useAuth();
  const navigate = useNavigate();

  // Tier gates — hide items the user can't act on.
  // The decisions mirror existing permissions used elsewhere in the app:
  //   - Workspace creation is `create_workspace` (sidebar +ws button)
  //   - Board creation is `create_board` (sidebar +board button)
  //   - Workflow / Folder / Form are tier ≥ 2 in the skill spec
  //   - Magic AI is AI-tier-gated — hide if AI is explicitly denied
  const canBoard = !!onCreateBoard && !isExplicitlyDenied('board', 'create', isSuperAdmin, granularPermissions);
  const canWorkspace = !!onCreateWorkspace && (canManage || isSuperAdmin);
  const canDoc = !!onCreateDoc;
  const canDashboard = !!onCreateDashboard && (canManage || isSuperAdmin);
  const canForm = !!onCreateForm && (canManage || isSuperAdmin);
  const canWorkflow = !!onCreateWorkflow && (canManage || isSuperAdmin);
  const canFolder = !!onCreateFolder && (canManage || isSuperAdmin);
  const canProject = !!onCreateProject;
  const canPortfolio = !!onCreatePortfolio && (canManage || isSuperAdmin);
  const canMagic = !!onOpenMagic && !isExplicitlyDenied('ai', 'use', isSuperAdmin, granularPermissions);

  function go(handler, opts) {
    onOpenChange?.(false);
    if (typeof handler === 'function') handler(opts || { workspaceId });
  }

  const sections = [
    {
      label: null,
      items: [
        canProject && { key: 'project', icon: Briefcase, label: 'Project', onSelect: () => go(onCreateProject) },
        canPortfolio && { key: 'portfolio', icon: FolderKanban, label: 'Portfolio', onSelect: () => go(onCreatePortfolio) },
      ].filter(Boolean),
    },
    {
      label: 'Boards & docs',
      items: [
        canBoard && {
          key: 'board',
          icon: LayoutGrid,
          label: 'Board',
          sublabel: 'A spreadsheet-style workspace for tasks',
          onSelect: () => go(onCreateBoard),
        },
        canDoc && {
          key: 'doc',
          icon: FileText,
          label: 'Doc',
          sublabel: 'A collaborative document',
          onSelect: () => go(onCreateDoc),
        },
        canDashboard && {
          key: 'dashboard',
          icon: BarChart3,
          label: 'Dashboard',
          sublabel: 'Widgets across multiple boards',
          onSelect: () => go(onCreateDashboard),
        },
        canForm && {
          key: 'form',
          icon: ClipboardList,
          label: 'Form',
          sublabel: 'Collect responses into a board',
          onSelect: () => go(onCreateForm),
        },
      ].filter(Boolean),
    },
    {
      label: 'Automate',
      items: [
        canWorkflow && {
          key: 'workflow',
          icon: Workflow,
          label: 'Workflow',
          sublabel: 'A multi-step automation',
          onSelect: () => go(onCreateWorkflow),
        },
        canMagic && {
          key: 'magic',
          icon: Sparkles,
          label: 'Magic AI solution',
          sublabel: 'Let AI build a workspace for you',
          accent: 'gradient',
          onSelect: () => go(onOpenMagic),
        },
      ].filter(Boolean),
    },
    {
      label: 'Organize',
      items: [
        canFolder && {
          key: 'folder',
          icon: Folder,
          label: 'Folder',
          sublabel: 'Group boards and docs',
          onSelect: () => go(onCreateFolder),
        },
        canWorkspace && {
          key: 'workspace',
          icon: FolderKanban,
          label: 'Workspace',
          sublabel: 'A new top-level container',
          onSelect: () => go(onCreateWorkspace),
        },
      ].filter(Boolean),
    },
  ].filter((s) => s.items.length > 0);

  return (
    <Popover open={open} onOpenChange={onOpenChange} placement={placement} offset={6}>
      <Popover.Trigger>{trigger}</Popover.Trigger>
      <Popover.Content width={320} ariaLabel="Add new content">
        <div
          className="py-1 rounded-md shadow-md"
          style={{
            backgroundColor: 'var(--primary-background-color, #ffffff)',
            border: '1px solid var(--layout-border-color, #e2e2e2)',
          }}
        >
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide font-semibold text-text-tertiary">
            Add new
          </div>

          {sections.length === 0 && (
            <div className="px-3 py-4 text-sm text-text-tertiary">
              No content types available.
            </div>
          )}

          {sections.map((section, idx) => (
            <div key={idx}>
              {section.label && (
                <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wide font-semibold text-text-tertiary">
                  {section.label}
                </div>
              )}
              {section.items.map((it) => {
                const Icon = it.icon;
                const isGradient = it.accent === 'gradient';
                return (
                  <button
                    key={it.key}
                    type="button"
                    onClick={it.onSelect}
                    className="w-full flex items-start gap-3 px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-100 transition-colors"
                  >
                    <span
                      className={`flex-shrink-0 mt-0.5 w-7 h-7 rounded-md inline-flex items-center justify-center ${
                        isGradient
                          ? 'text-white'
                          : 'bg-primary-50 text-primary'
                      }`}
                      style={isGradient ? {
                        backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 33%, #00c875 66%, #ffcb00 100%)',
                      } : undefined}
                    >
                      <Icon size={15} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-semibold leading-tight">{it.label}</span>
                      {it.sublabel && (
                        <span className="block text-xs text-text-tertiary mt-0.5 truncate">{it.sublabel}</span>
                      )}
                    </span>
                    <ChevronRight size={14} className="flex-shrink-0 mt-1.5 text-text-tertiary" />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </Popover.Content>
    </Popover>
  );
}
