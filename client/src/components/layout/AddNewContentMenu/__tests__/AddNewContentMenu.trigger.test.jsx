import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../../context/AuthContext', () => ({
  useAuth: vi.fn(() => ({
    isSuperAdmin: true,
    canManage: true,
    isStrictAdmin: true,
    granularPermissions: {},
  })),
}));

// Regression guard for the "+ Add new" button doing nothing.
//
// The sibling AddNewContentMenu.test.jsx mocks framer-motion AND forces the
// Popover `open`, so it never exercised the trigger-click → open path. That
// blind spot hid a real bug: AnimatePresence wrapped a keyless
// `createPortal(...)` child, and framer-motion 12 skipped rendering it, so the
// menu never appeared in the browser. This test intentionally uses the REAL
// framer-motion and drives the click, so a regression here fails loudly.
import AddNewContentMenu from '../AddNewContentMenu';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <AddNewContentMenu
        open={open}
        onOpenChange={setOpen}
        placement="top-start"
        trigger={<button>Add new</button>}
        onCreateBoard={() => {}}
        onCreateWorkspace={() => {}}
        onCreateDoc={() => {}}
      />
    </MemoryRouter>
  );
}

describe('AddNewContentMenu trigger (real Popover)', () => {
  it('opens the menu when the trigger button is clicked', async () => {
    render(<Harness />);
    // Menu closed initially.
    expect(screen.queryByText('Board')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Add new'));
    await waitFor(() => expect(screen.getByText('Board')).toBeInTheDocument());
  });
});
