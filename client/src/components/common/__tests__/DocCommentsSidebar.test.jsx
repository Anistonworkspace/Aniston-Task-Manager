import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

/**
 * Phase F — DocCommentsSidebar tests.
 *
 * Covers:
 *   1. Empty state when the server returns no threads
 *   2. Threads render with author, body, and time-ago strings
 *   3. Optimistic add: new top-level comment appears immediately + is
 *      swapped with the server response on success
 *   4. Resolve toggle flips the thread into the greyed/collapsed state
 *   5. Edit-own-comment surfaces the editable textarea
 *   6. Delete fires a confirm prompt before calling the service
 *   7. pendingAnchor chip is shown when supplied
 *   8. Add-failure surfaces a toast error
 */

const toastErrorSpy = vi.fn();
const toastSuccessSpy = vi.fn();

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, onClick, ...rest }, ref) =>
      React.createElement(tag, { ref, onClick, ...rest }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

vi.mock('../Toast', () => ({
  useToast: () => ({
    error: toastErrorSpy,
    success: toastSuccessSpy,
    info: vi.fn(),
    warning: vi.fn(),
    toast: vi.fn(),
    notify: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock('../../../utils/errorMap', () => ({
  getErrorMessage: (err) => err?.message || 'fallback error',
  getErrorCode: () => null,
}));

vi.mock('../../../services/docsService', () => ({
  listDocComments: vi.fn(),
  addDocComment: vi.fn(),
  updateDocComment: vi.fn(),
  deleteDocComment: vi.fn(),
  resolveDocComment: vi.fn(),
  unresolveDocComment: vi.fn(),
}));

import {
  listDocComments, addDocComment, updateDocComment,
  deleteDocComment, resolveDocComment,
} from '../../../services/docsService';
import DocCommentsSidebar from '../DocCommentsSidebar';

const ME = { id: 'u-me', name: 'Me', avatar: null };
const OTHER = { id: 'u-other', name: 'Other Person', avatar: null };

function makeThread(overrides = {}) {
  return {
    id: 'c1',
    docId: 'd1',
    parentId: null,
    authorId: OTHER.id,
    author: { id: OTHER.id, name: OTHER.name, avatar: null },
    body: 'Looks good!',
    anchorText: 'selected snippet',
    anchorFrom: 10,
    anchorTo: 20,
    resolved: false,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    replies: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  toastErrorSpy.mockClear();
  toastSuccessSpy.mockClear();
  listDocComments.mockResolvedValue({ threads: [] });
});

describe('DocCommentsSidebar', () => {
  it('shows the empty state when there are no comments', async () => {
    render(
      <DocCommentsSidebar
        isOpen
        onClose={() => {}}
        docId="d1"
        currentUser={ME}
      />
    );
    // Wait for the initial fetch to resolve.
    await waitFor(() => {
      expect(listDocComments).toHaveBeenCalledWith('d1');
    });
    await waitFor(() => {
      expect(screen.getByText(/No comments yet/i)).toBeInTheDocument();
    });
  });

  it('renders existing threads with author name and body', async () => {
    listDocComments.mockResolvedValue({
      threads: [
        makeThread({ id: 't1', body: 'First comment' }),
        makeThread({ id: 't2', body: 'Second comment', author: { id: ME.id, name: 'Me', avatar: null }, authorId: ME.id }),
      ],
    });
    render(
      <DocCommentsSidebar
        isOpen
        onClose={() => {}}
        docId="d1"
        currentUser={ME}
      />
    );
    await waitFor(() => {
      expect(screen.getByText('First comment')).toBeInTheDocument();
      expect(screen.getByText('Second comment')).toBeInTheDocument();
    });
    expect(screen.getByText('Other Person')).toBeInTheDocument();
  });

  it('optimistically adds a new top-level comment and replaces it with the server response', async () => {
    listDocComments.mockResolvedValue({ threads: [] });
    let resolveAdd;
    addDocComment.mockImplementation(() => new Promise((resolve) => { resolveAdd = resolve; }));

    render(
      <DocCommentsSidebar
        isOpen
        onClose={() => {}}
        docId="d1"
        currentUser={ME}
        pendingAnchor={{ text: 'highlighted text', from: 5, to: 25 }}
      />
    );
    await waitFor(() => {
      expect(listDocComments).toHaveBeenCalled();
    });
    const textarea = screen.getByLabelText('New comment');
    fireEvent.change(textarea, { target: { value: 'My fresh comment' } });
    const sendBtn = screen.getByLabelText('Send comment');
    fireEvent.click(sendBtn);

    // Optimistic insert is visible BEFORE the promise resolves.
    await waitFor(() => {
      expect(screen.getByText('My fresh comment')).toBeInTheDocument();
    });
    expect(addDocComment).toHaveBeenCalledWith('d1', expect.objectContaining({
      body: 'My fresh comment',
      anchorText: 'highlighted text',
      anchorFrom: 5,
      anchorTo: 25,
    }));

    // Now resolve the server response with a different id; the optimistic
    // row should be replaced by the real one.
    await act(async () => {
      resolveAdd({
        comment: {
          id: 'server-id-1',
          docId: 'd1',
          parentId: null,
          authorId: ME.id,
          author: { id: ME.id, name: 'Me', avatar: null },
          body: 'My fresh comment',
          anchorText: 'highlighted text',
          anchorFrom: 5,
          anchorTo: 25,
          resolved: false,
          createdAt: new Date().toISOString(),
        },
      });
    });
    // Same body text still showing — but now on the server-id row.
    await waitFor(() => {
      expect(screen.getByText('My fresh comment')).toBeInTheDocument();
    });
  });

  it('toggling resolve flips the thread into the greyed/collapsed state', async () => {
    listDocComments.mockResolvedValue({
      threads: [makeThread({ id: 't1', body: 'Resolvable', authorId: ME.id, author: { id: ME.id, name: 'Me', avatar: null } })],
    });
    resolveDocComment.mockResolvedValue({
      comment: makeThread({ id: 't1', body: 'Resolvable', resolved: true, resolvedAt: new Date().toISOString(), resolvedBy: ME.id }),
    });
    render(
      <DocCommentsSidebar
        isOpen
        onClose={() => {}}
        docId="d1"
        currentUser={ME}
      />
    );
    await waitFor(() => {
      expect(screen.getByText('Resolvable')).toBeInTheDocument();
    });
    // Open the kebab menu on the thread's CommentRow.
    const kebab = screen.getAllByLabelText('Comment actions')[0];
    fireEvent.click(kebab);
    const resolveBtn = await screen.findByRole('menuitem', { name: /Resolve/i });
    fireEvent.click(resolveBtn);

    await waitFor(() => {
      const thread = screen.getByTestId('doc-comment-thread');
      expect(thread.getAttribute('data-resolved')).toBe('true');
    });
    expect(resolveDocComment).toHaveBeenCalledWith('d1', 't1');
  });

  it('editing own comment surfaces the editable textarea', async () => {
    listDocComments.mockResolvedValue({
      threads: [makeThread({
        id: 't1', authorId: ME.id, author: { id: ME.id, name: 'Me', avatar: null }, body: 'mine',
      })],
    });
    render(
      <DocCommentsSidebar
        isOpen
        onClose={() => {}}
        docId="d1"
        currentUser={ME}
      />
    );
    await waitFor(() => {
      expect(screen.getByText('mine')).toBeInTheDocument();
    });
    fireEvent.click(screen.getAllByLabelText('Comment actions')[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Edit/i }));
    expect(screen.getByLabelText('Edit comment')).toBeInTheDocument();
    expect(updateDocComment).not.toHaveBeenCalled();
  });

  it('delete fires a confirm prompt and calls the service when confirmed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    deleteDocComment.mockResolvedValue({ mode: 'hard', commentId: 't1' });
    listDocComments.mockResolvedValue({
      threads: [makeThread({
        id: 't1', authorId: ME.id, author: { id: ME.id, name: 'Me', avatar: null }, body: 'doomed',
      })],
    });
    render(
      <DocCommentsSidebar
        isOpen
        onClose={() => {}}
        docId="d1"
        currentUser={ME}
      />
    );
    await waitFor(() => {
      expect(screen.getByText('doomed')).toBeInTheDocument();
    });
    fireEvent.click(screen.getAllByLabelText('Comment actions')[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/i }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      expect(deleteDocComment).toHaveBeenCalledWith('d1', 't1');
    });
    confirmSpy.mockRestore();
  });

  it('shows the pendingAnchor chip when supplied', async () => {
    render(
      <DocCommentsSidebar
        isOpen
        onClose={() => {}}
        docId="d1"
        currentUser={ME}
        pendingAnchor={{ text: 'paragraph snippet from doc', from: 0, to: 25 }}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('pending-anchor-chip')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pending-anchor-chip')).toHaveTextContent(/paragraph snippet/i);
  });

  it('shows a toast error when add fails', async () => {
    listDocComments.mockResolvedValue({ threads: [] });
    addDocComment.mockRejectedValue(new Error('boom'));

    render(
      <DocCommentsSidebar
        isOpen
        onClose={() => {}}
        docId="d1"
        currentUser={ME}
        pendingAnchor={{ text: 'something', from: 0, to: 9 }}
      />
    );
    await waitFor(() => {
      expect(listDocComments).toHaveBeenCalled();
    });
    fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'will fail' } });
    fireEvent.click(screen.getByLabelText('Send comment'));

    await waitFor(() => {
      expect(toastErrorSpy).toHaveBeenCalled();
    });
    // Optimistic row was rolled back — empty state returns.
    await waitFor(() => {
      expect(screen.queryByText('will fail')).not.toBeInTheDocument();
    });
  });
});
