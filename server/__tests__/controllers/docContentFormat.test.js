'use strict';

/**
 * Phase 6 — backend support for the BlockNote content format.
 *
 * Tests the two boundary helpers that gained dual-format support:
 *   - sanitizeContentJson:  accept both Tiptap envelope AND BlockNote Block[]
 *   - extractContentText:   walk both shapes into the FTS plain-text shadow
 *
 * The helpers are not exported directly, so we drive them via the
 * `createPersonalDoc` controller path which is end-to-end and easier to
 * mock than reaching into module internals.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key';

jest.mock('../../models', () => ({
  Doc: {
    findByPk: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
  },
  DocVersion: { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), count: jest.fn() },
  DocMention: { findAll: jest.fn().mockResolvedValue([]), create: jest.fn(), destroy: jest.fn() },
  DocTaskReference: { findAll: jest.fn().mockResolvedValue([]), create: jest.fn(), destroy: jest.fn() },
  DocAccess: {
    findOne: jest.fn().mockResolvedValue(null),
    findAll: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'a-new' }),
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

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const OWNER = { id: 'u-owner', name: 'Owner', role: 'member', isSuperAdmin: false };

beforeEach(() => {
  jest.clearAllMocks();
  // Make `await Doc.findByPk(doc.id, { include: ... })` (the reload step)
  // return a serializable doc so the response payload assembles cleanly.
  Doc.create.mockImplementation((row) => Promise.resolve({
    id: 'd-new',
    ...row,
    toJSON: function () { return { id: this.id, ...row }; },
  }));
  Doc.findByPk.mockImplementation((id) => Promise.resolve({
    id, title: 'X',
    toJSON: function () { return { id: this.id }; },
  }));
});

describe('Phase 6 — createPersonalDoc defaults', () => {
  test('new doc with no body defaults to contentFormat=blocknote_json with [] seed', async () => {
    const req = { user: OWNER, body: { title: 'Notes' } };
    const res = mockRes();
    await docCtrl.createPersonalDoc(req, res);

    expect(Doc.create).toHaveBeenCalledTimes(1);
    const args = Doc.create.mock.calls[0][0];
    expect(args.contentFormat).toBe('blocknote_json');
    expect(args.contentJson).toEqual([]); // empty BlockNote seed
    expect(args.title).toBe('Notes');
    expect(args.ownerUserId).toBe(OWNER.id);
    expect(args.visibility).toBe('private');
    expect(args.sharePolicy).toBe('private');
  });

  test('client can opt-in to tiptap_json with explicit format', async () => {
    const req = {
      user: OWNER,
      body: { title: 'Legacy', contentFormat: 'tiptap_json' },
    };
    const res = mockRes();
    await docCtrl.createPersonalDoc(req, res);

    const args = Doc.create.mock.calls[0][0];
    expect(args.contentFormat).toBe('tiptap_json');
    expect(args.contentJson).toEqual({ type: 'doc', content: [] }); // Tiptap empty seed
  });

  test('client supplying BlockNote Block[] is accepted and persisted', async () => {
    const blocks = [
      {
        id: 'b1', type: 'paragraph', props: {},
        content: [{ type: 'text', text: 'Hello world', styles: {} }],
        children: [],
      },
    ];
    const req = {
      user: OWNER,
      body: { title: 'BN', contentFormat: 'blocknote_json', contentJson: blocks },
    };
    const res = mockRes();
    await docCtrl.createPersonalDoc(req, res);

    const args = Doc.create.mock.calls[0][0];
    expect(args.contentJson).toEqual(blocks);
    expect(args.contentFormat).toBe('blocknote_json');
    // FTS shadow extracted from the BlockNote shape.
    expect(args.contentText).toBe('Hello world');
  });

  test('client supplying Tiptap envelope is accepted and persisted', async () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Tiptap text' }] },
      ],
    };
    const req = {
      user: OWNER,
      body: { title: 'TT', contentFormat: 'tiptap_json', contentJson: doc },
    };
    const res = mockRes();
    await docCtrl.createPersonalDoc(req, res);

    const args = Doc.create.mock.calls[0][0];
    expect(args.contentJson).toEqual(doc);
    expect(args.contentText).toBe('Tiptap text');
  });
});

describe('Phase 6 — extractContentText handles both formats', () => {
  // We exercise the helper indirectly via createPersonalDoc since it's not
  // exported. Each assertion checks the persisted `contentText` shadow.

  test('walks nested BlockNote children (lists, toggles)', async () => {
    const blocks = [
      {
        id: 'b1', type: 'bulletListItem', props: {},
        content: [{ type: 'text', text: 'Item 1', styles: {} }],
        children: [
          {
            id: 'b2', type: 'bulletListItem', props: {},
            content: [{ type: 'text', text: 'Nested A', styles: {} }],
            children: [],
          },
          {
            id: 'b3', type: 'bulletListItem', props: {},
            content: [{ type: 'text', text: 'Nested B', styles: {} }],
            children: [],
          },
        ],
      },
    ];
    const req = {
      user: OWNER,
      body: { contentFormat: 'blocknote_json', contentJson: blocks },
    };
    await docCtrl.createPersonalDoc(req, mockRes());

    const args = Doc.create.mock.calls[0][0];
    expect(args.contentText).toBe('Item 1 Nested A Nested B');
  });

  test('walks deeply-nested Tiptap structure', async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Beta' }] }] },
          ],
        },
      ],
    };
    const req = {
      user: OWNER,
      body: { contentFormat: 'tiptap_json', contentJson: doc },
    };
    await docCtrl.createPersonalDoc(req, mockRes());

    const args = Doc.create.mock.calls[0][0];
    expect(args.contentText).toBe('Alpha Beta');
  });
});

describe('Phase 6 — sanitizeContentJson rejects malformed inputs', () => {
  test('rejects an array of primitives (not Block objects)', async () => {
    const req = {
      user: OWNER,
      body: { contentFormat: 'blocknote_json', contentJson: ['nope', 42, null] },
    };
    const res = mockRes();
    await docCtrl.createPersonalDoc(req, res);

    // Falls back to the empty BlockNote seed (sanitize returned null).
    const args = Doc.create.mock.calls[0][0];
    expect(args.contentJson).toEqual([]);
  });

  test('rejects Tiptap-shaped object with wrong .type', async () => {
    const req = {
      user: OWNER,
      body: { contentFormat: 'tiptap_json', contentJson: { type: 'paragraph', content: [] } },
    };
    const res = mockRes();
    await docCtrl.createPersonalDoc(req, res);

    // Falls back to the Tiptap empty seed.
    const args = Doc.create.mock.calls[0][0];
    expect(args.contentJson).toEqual({ type: 'doc', content: [] });
  });

  test('accepts empty BlockNote array (seed for fresh editor)', async () => {
    const req = {
      user: OWNER,
      body: { contentFormat: 'blocknote_json', contentJson: [] },
    };
    await docCtrl.createPersonalDoc(req, mockRes());

    const args = Doc.create.mock.calls[0][0];
    expect(args.contentJson).toEqual([]);
  });
});
