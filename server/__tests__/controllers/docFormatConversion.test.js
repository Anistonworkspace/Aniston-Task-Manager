'use strict';

/**
 * Phase 7 — owner-only Tiptap→BlockNote conversion path + BlockNote-aware
 * mention/task-ref extraction.
 *
 * Tests:
 *   - updateDoc accepts contentFormat change (owner-only) and auto-snapshots
 *     legacyContentJson
 *   - non-owner cannot flip contentFormat
 *   - legacyContentJson is never overwritten on re-convert
 *   - extractMentions walks BlockNote inline content + nested children
 *   - extractTaskRefs walks BlockNote inline content + nested children
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key';

jest.mock('../../models', () => ({
  Doc: { findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn() },
  DocVersion: { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), count: jest.fn().mockResolvedValue(0) },
  DocMention: { findAll: jest.fn().mockResolvedValue([]), create: jest.fn(), destroy: jest.fn() },
  DocTaskReference: { findAll: jest.fn().mockResolvedValue([]), create: jest.fn(), destroy: jest.fn() },
  DocAccess: {
    findOne: jest.fn().mockResolvedValue(null),
    findAll: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    destroy: jest.fn(),
  },
  Workspace: { findByPk: jest.fn() },
  User: { findByPk: jest.fn(), findAll: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));

const { Doc } = require('../../models');
const docCtrl = require('../../controllers/docController');
const { __extractMentions, __extractTaskRefs } = docCtrl;

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const OWNER = { id: 'u-owner', name: 'Owner', isSuperAdmin: false };
const SHARED = { id: 'u-shared', name: 'Shared', isSuperAdmin: false };
const TIPTAP_DOC = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Legacy content' }] },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  Doc.findByPk.mockImplementation((id) => Promise.resolve(null));
});

describe('Phase 7 — updateDoc contentFormat conversion', () => {
  test('owner can flip tiptap_json → blocknote_json; legacyContentJson auto-snapshotted', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const doc = {
      id: 'd1',
      ownerUserId: OWNER.id,
      contentFormat: 'tiptap_json',
      contentJson: TIPTAP_DOC,
      legacyContentJson: null,
      title: 'X',
      update,
      toJSON() { return { id: this.id }; },
    };
    Doc.findByPk.mockResolvedValue(doc);

    const newBlocks = [
      { id: 'b1', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Migrated', styles: {} }], children: [] },
    ];
    const req = {
      user: OWNER,
      params: { id: 'd1' },
      body: { contentJson: newBlocks, contentFormat: 'blocknote_json' },
    };
    await docCtrl.updateDoc(req, mockRes());

    expect(update).toHaveBeenCalledTimes(1);
    const args = update.mock.calls[0][0];
    expect(args.contentFormat).toBe('blocknote_json');
    expect(args.contentJson).toEqual(newBlocks);
    // The original Tiptap doc must be preserved verbatim.
    expect(args.legacyContentJson).toEqual(TIPTAP_DOC);
  });

  // June 2026 — every doc auto-migrates to BlockNote on open, and the
  // migration is lossless (legacyContentJson + version snapshot). So an
  // edit-level collaborator may now complete the format flip too; only
  // comment/view callers (who can't reach updateDoc at all) are excluded.
  test('non-owner with edit access CAN flip contentFormat (lossless migration)', async () => {
    const update = jest.fn();
    const doc = {
      id: 'd1',
      ownerUserId: OWNER.id,
      contentFormat: 'tiptap_json',
      contentJson: TIPTAP_DOC,
      legacyContentJson: null,
      title: 'X',
      update,
      toJSON() { return { id: this.id }; },
    };
    Doc.findByPk.mockResolvedValue(doc);
    // Give SHARED edit-level grant so they pass the body-edit gate.
    const { DocAccess } = require('../../models');
    DocAccess.findOne.mockResolvedValue({ accessLevel: 'edit' });

    const req = {
      user: SHARED,
      params: { id: 'd1' },
      body: { contentJson: TIPTAP_DOC, contentFormat: 'blocknote_json' },
    };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(update).toHaveBeenCalledTimes(1);
    const args = update.mock.calls[0][0];
    expect(args.contentFormat).toBe('blocknote_json');
    // Original Tiptap source preserved for recovery.
    expect(args.legacyContentJson).toEqual(TIPTAP_DOC);
  });

  test('re-converting a doc does NOT overwrite an existing legacyContentJson', async () => {
    // legacyContentJson already populated from a prior conversion. A second
    // PATCH that toggles back to tiptap_json then forward to blocknote_json
    // should preserve the ORIGINAL Tiptap source, not the intermediate one.
    const update = jest.fn().mockResolvedValue(undefined);
    const originalTiptap = TIPTAP_DOC;
    const intermediate = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Intermediate' }] }] };
    const doc = {
      id: 'd1',
      ownerUserId: OWNER.id,
      contentFormat: 'tiptap_json',
      contentJson: intermediate,
      legacyContentJson: originalTiptap, // already snapshot from a prior conversion
      title: 'X',
      update,
      toJSON() { return { id: this.id }; },
    };
    Doc.findByPk.mockResolvedValue(doc);

    const req = {
      user: OWNER,
      params: { id: 'd1' },
      body: {
        contentJson: [{ id: 'b1', type: 'paragraph', props: {}, content: [], children: [] }],
        contentFormat: 'blocknote_json',
      },
    };
    await docCtrl.updateDoc(req, mockRes());

    const args = update.mock.calls[0][0];
    // legacyContentJson should NOT appear in the update payload — the
    // controller skips the snapshot when one already exists.
    expect(args).not.toHaveProperty('legacyContentJson');
    expect(args.contentFormat).toBe('blocknote_json');
  });

  test('same-format PATCH (no change) does not touch contentFormat or legacyContentJson', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const doc = {
      id: 'd1',
      ownerUserId: OWNER.id,
      contentFormat: 'blocknote_json',
      contentJson: [],
      legacyContentJson: null,
      title: 'X',
      update,
      toJSON() { return { id: this.id }; },
    };
    Doc.findByPk.mockResolvedValue(doc);

    const req = {
      user: OWNER,
      params: { id: 'd1' },
      body: { title: 'Renamed', contentFormat: 'blocknote_json' }, // same format — no-op
    };
    await docCtrl.updateDoc(req, mockRes());

    const args = update.mock.calls[0][0];
    expect(args).not.toHaveProperty('contentFormat');
    expect(args).not.toHaveProperty('legacyContentJson');
    expect(args.title).toBe('Renamed');
  });
});

describe('Phase 7 — extractMentions handles both formats', () => {
  test('walks Tiptap mention attrs.id', () => {
    const out = __extractMentions({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hi ' },
            { type: 'mention', attrs: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: 'Sara' } },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  test('walks BlockNote mention props.userId in inline content', () => {
    const blocks = [
      {
        id: 'b1', type: 'paragraph', props: {},
        content: [
          { type: 'text', text: 'Hey ', styles: {} },
          { type: 'mention', props: { userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', label: 'Mike' } },
          { type: 'text', text: '!', styles: {} },
        ],
        children: [],
      },
    ];
    const out = __extractMentions(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  test('walks mentions inside BlockNote nested children (list items)', () => {
    const blocks = [
      {
        id: 'b1', type: 'bulletListItem', props: {},
        content: [{ type: 'text', text: 'top', styles: {} }],
        children: [
          {
            id: 'b2', type: 'bulletListItem', props: {},
            content: [
              { type: 'mention', props: { userId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', label: 'Nested' } },
            ],
            children: [],
          },
        ],
      },
    ];
    const out = __extractMentions(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc');
  });

  test('dedups mentions across the doc (unique per userId)', () => {
    const blocks = [
      {
        id: 'b1', type: 'paragraph', props: {},
        content: [
          { type: 'mention', props: { userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: 'Sara' } },
          { type: 'text', text: ' and ', styles: {} },
          { type: 'mention', props: { userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: 'Sara again' } },
        ],
        children: [],
      },
    ];
    const out = __extractMentions(blocks);
    expect(out).toHaveLength(1);
  });

  test('drops malformed mention with non-UUID id', () => {
    const blocks = [
      {
        id: 'b1', type: 'paragraph', props: {},
        content: [{ type: 'mention', props: { userId: 'not-a-uuid', label: 'X' } }],
        children: [],
      },
    ];
    expect(__extractMentions(blocks)).toEqual([]);
  });
});

describe('Phase 7 — extractTaskRefs handles both formats', () => {
  test('walks Tiptap taskChip attrs.taskId', () => {
    const out = __extractTaskRefs({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [
          { type: 'taskChip', attrs: { taskId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: 'Task' } },
        ] },
      ],
    });
    expect(out).toHaveLength(1);
  });

  test('walks BlockNote task inline content props.taskId', () => {
    const blocks = [
      {
        id: 'b1', type: 'paragraph', props: {},
        content: [{ type: 'task', props: { taskId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', label: 'Buy milk' } }],
        children: [],
      },
    ];
    const out = __extractTaskRefs(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].taskId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });
});
