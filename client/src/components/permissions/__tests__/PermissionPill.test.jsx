import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import PermissionPill, { categorizeAction } from '../PermissionPill';

// Phase B (May 2026 RBAC UI hardening). Pins the category mapper + render
// semantics so the granular Phase A action set (labels.create,
// labels.add_to_task, tasks.assign_self, tasks.edit_own, etc.) renders with
// the right colour/effect/badge family without an exhaustive per-action
// lookup table.

describe('categorizeAction — token-driven mapping', () => {
  it('classifies destructive verbs', () => {
    expect(categorizeAction('delete')).toBe('destructive');
    expect(categorizeAction('permanent_delete')).toBe('destructive');
    expect(categorizeAction('remove_from_task')).toBe('destructive');
    expect(categorizeAction('archive')).toBe('destructive');
    expect(categorizeAction('revoke')).toBe('destructive');
    expect(categorizeAction('reject')).toBe('destructive');
    expect(categorizeAction('unassign_self')).toBe('destructive');
  });

  it('classifies admin verbs', () => {
    expect(categorizeAction('manage')).toBe('admin');
    expect(categorizeAction('manage_members')).toBe('admin');
    expect(categorizeAction('grant')).toBe('admin');
    expect(categorizeAction('permission_grant')).toBe('admin');
    expect(categorizeAction('configure')).toBe('admin');
  });

  it('classifies read verbs', () => {
    expect(categorizeAction('view')).toBe('read');
    expect(categorizeAction('view_all')).toBe('read');
    expect(categorizeAction('view_sensitive_stats')).toBe('read');
    expect(categorizeAction('list')).toBe('read');
    expect(categorizeAction('search')).toBe('read');
    expect(categorizeAction('export')).toBe('read');
  });

  it('classifies write verbs', () => {
    expect(categorizeAction('create')).toBe('write');
    expect(categorizeAction('edit')).toBe('write');
    expect(categorizeAction('edit_own')).toBe('write');
    expect(categorizeAction('add_to_task')).toBe('write');
    expect(categorizeAction('assign_self')).toBe('write');
    expect(categorizeAction('assign_others')).toBe('write');
    expect(categorizeAction('approve')).toBe('write');
    expect(categorizeAction('restore')).toBe('write');
  });

  it('falls back to default for unknown / empty actions', () => {
    expect(categorizeAction('')).toBe('default');
    expect(categorizeAction(null)).toBe('default');
    expect(categorizeAction(undefined)).toBe('default');
    expect(categorizeAction('xyz_quux')).toBe('default');
  });

  it('destructive precedence beats admin when both tokens are present', () => {
    // 'manage_delete' (hypothetical) — destructive should win because
    // removal is the more severe message.
    expect(categorizeAction('manage_delete')).toBe('destructive');
  });
});

describe('PermissionPill — category rendering', () => {
  it('renders the label text', () => {
    render(<PermissionPill action="create" label="Create" />);
    expect(screen.getByText('Create')).toBeInTheDocument();
  });

  it('applies the destructive palette for delete-family actions', () => {
    const { getByText } = render(<PermissionPill action="permanent_delete" label="Permanently delete" />);
    const pill = getByText('Permanently delete');
    expect(pill).toHaveAttribute('data-category', 'destructive');
    expect(pill.className).toMatch(/red/);
  });

  it('applies the read palette for view-family actions', () => {
    const { getByText } = render(<PermissionPill action="view_all" label="View all" />);
    expect(getByText('View all')).toHaveAttribute('data-category', 'read');
  });

  it('applies the admin palette for manage-family actions', () => {
    const { getByText } = render(<PermissionPill action="manage_members" label="Manage members" />);
    expect(getByText('Manage members')).toHaveAttribute('data-category', 'admin');
  });

  it('honours an explicit category prop over auto-categorisation', () => {
    // action would categorise as 'write' but we force 'default' for a
    // resource-style chip. This is how the resource MultiSelect uses it.
    const { getByText } = render(<PermissionPill action="create" category="default" label="Tasks" />);
    expect(getByText('Tasks')).toHaveAttribute('data-category', 'default');
  });

  it('renders the resource category in Monday-primary blue', () => {
    // Resource chips in the AdminSettings MultiSelect use category="resource"
    // so they read as resource selections (primary brand colour), visually
    // distinct from action chips (which take the action-verb category).
    const { getByText } = render(<PermissionPill category="resource" label="Tasks" />);
    const pill = getByText('Tasks');
    expect(pill).toHaveAttribute('data-category', 'resource');
    expect(pill.className).toMatch(/primary/);
  });
});

describe('PermissionPill — effect overlays', () => {
  it('uses red+strikethrough when effect=deny regardless of category', () => {
    // Action would normally be 'write' (amber); deny effect forces red.
    const { getByText } = render(
      <PermissionPill action="create" label="Create" effect="deny" />,
    );
    const pill = getByText('Create');
    expect(pill).toHaveAttribute('data-effect', 'deny');
    expect(pill.className).toMatch(/line-through/);
    expect(pill.className).toMatch(/red/);
  });

  it('uses emerald palette for effect=base', () => {
    const { getByText } = render(
      <PermissionPill action="delete" label="Delete" effect="base" />,
    );
    const pill = getByText('Delete');
    // base means "permission is allowed" — emerald wins over the action's
    // destructive category. Test rendered classes include emerald.
    expect(pill.className).toMatch(/emerald/);
  });

  it('uses greyed line-through for effect=not_allowed', () => {
    const { getByText } = render(
      <PermissionPill action="create" label="Create" effect="not_allowed" />,
    );
    const pill = getByText('Create');
    expect(pill.className).toMatch(/line-through/);
    expect(pill.className).toMatch(/gray|zinc/);
  });
});

describe('PermissionPill — badge precedence', () => {
  it('Locked beats every other auto-badge', () => {
    render(
      <PermissionPill
        action="create"
        label="Create"
        enforcement="locked"
        dangerous
        warnOnDeny
        effect="deny"
      />,
    );
    expect(screen.getByText('Locked')).toBeInTheDocument();
    expect(screen.queryByText('Dangerous')).not.toBeInTheDocument();
    expect(screen.queryByText('Default ON')).not.toBeInTheDocument();
  });

  it('Not enforceable beats Pending + Dangerous', () => {
    render(
      <PermissionPill action="create" label="Create" enforcement="no_surface" dangerous />,
    );
    expect(screen.getByText('Not enforceable')).toBeInTheDocument();
    expect(screen.queryByText('Dangerous')).not.toBeInTheDocument();
  });

  it('Pending beats Dangerous', () => {
    render(
      <PermissionPill action="create" label="Create" enforcement="pending" dangerous />,
    );
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText('Dangerous')).not.toBeInTheDocument();
  });

  it('Dangerous renders when enforcement is wired', () => {
    render(<PermissionPill action="delete" label="Delete" dangerous enforcement="wired" />);
    expect(screen.getByText('Dangerous')).toBeInTheDocument();
  });

  it('Default ON only renders when effect=deny', () => {
    const { rerender } = render(
      <PermissionPill action="view" label="View" warnOnDeny effect="grant" />,
    );
    expect(screen.queryByText('Default ON')).not.toBeInTheDocument();

    rerender(<PermissionPill action="view" label="View" warnOnDeny effect="deny" />);
    expect(screen.getByText('Default ON')).toBeInTheDocument();
  });

  it('explicit badge prop wins over derived flags', () => {
    render(
      <PermissionPill action="create" label="Create" badge="Custom" enforcement="locked" />,
    );
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.queryByText('Locked')).not.toBeInTheDocument();
  });
});

describe('PermissionPill — onRemove affordance', () => {
  it('does not render an X button when onRemove is omitted', () => {
    render(<PermissionPill action="create" label="Create" />);
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('calls onRemove when the X button is clicked', () => {
    const onRemove = vi.fn();
    render(<PermissionPill action="create" label="Create" onRemove={onRemove} />);
    const btn = screen.getByRole('button', { name: /remove create/i });
    fireEvent.click(btn);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('stops propagation so a parent dropdown does not toggle on chip removal', () => {
    const parentClick = vi.fn();
    const onRemove = vi.fn();
    render(
      <div onClick={parentClick}>
        <PermissionPill action="create" label="Create" onRemove={onRemove} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove create/i }));
    expect(onRemove).toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
  });
});

describe('PermissionPill — tooltip composition', () => {
  it('combines resource.action + description + reason in the title attribute', () => {
    render(
      <PermissionPill
        action="add_to_task"
        resource="labels"
        label="Add to task"
        description="Attach a label to a task"
        reason="Default-on for everyone with task edit"
      />,
    );
    const pill = screen.getByText('Add to task');
    const title = pill.getAttribute('title');
    expect(title).toContain('labels.add_to_task');
    expect(title).toContain('Attach a label to a task');
    expect(title).toContain('Default-on for everyone with task edit');
  });

  it('falls back to the badge tooltip when description/reason are absent', () => {
    render(
      <PermissionPill action="create" label="Create" enforcement="locked" />,
    );
    const pill = screen.getByText('Create');
    expect(pill.getAttribute('title')).toMatch(/System rule/i);
  });

  it('omits title attribute when no tooltip parts are present', () => {
    // No action / resource / description / reason / badge → no title set.
    render(<PermissionPill category="default" label="Tasks" />);
    expect(screen.getByText('Tasks')).not.toHaveAttribute('title');
  });
});

describe('PermissionPill — size variants', () => {
  it('default size is sm', () => {
    const { getByText } = render(<PermissionPill action="view" label="View" />);
    expect(getByText('View').className).toMatch(/text-\[10px\]/);
  });

  it('md size bumps the typography', () => {
    const { getByText } = render(<PermissionPill action="view" label="View" size="md" />);
    expect(getByText('View').className).toMatch(/text-xs/);
  });
});
