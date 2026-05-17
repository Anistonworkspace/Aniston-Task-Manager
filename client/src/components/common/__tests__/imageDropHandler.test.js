// Phase H-v2 — unit tests for the RichTextEditor image drop/paste plugin.
//
// We exercise the plugin's `handlePaste` / `handleDrop` props directly
// against a mock ProseMirror view rather than mounting a full Tiptap
// editor. Two reasons:
//   1. jsdom does not implement DataTransfer / ClipboardEvent fully
//      enough to route file payloads through Tiptap's real event chain,
//      so a "real" integration test would be lying about what happened.
//   2. The plugin's contract IS the public surface we care about —
//      handlePaste/handleDrop return a boolean and call uploadFn / onError
//      with the right shapes. That contract is what we lock in here.
//
// The `view` mock tracks every dispatched transaction so we can assert
// on the sequence: placeholder insert → final replace (success) OR
// placeholder insert → delete (failure).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildImageDropPastePlugin } from '../RichTextEditor';

// ─── Mock factories ──────────────────────────────────────────────────────

/**
 * Build a minimal ProseMirror view stand-in that tracks every dispatched
 * transaction. The transactions are recorded by intent — insert, replace,
 * delete — so the tests can assert on the placeholder lifecycle without
 * needing a real prosemirror-model doc.
 *
 * The mock implements the API surface the plugin actually touches:
 *   view.state.selection.from
 *   view.state.tr.insert / replaceWith / delete
 *   view.state.schema.nodes.image.create(attrs)
 *   view.state.doc.descendants(cb)
 *   view.dispatch(tr)
 *   view.posAtCoords({left, top})
 */
function makeView({ selectionFrom = 1, posAtCoords = null } = {}) {
  const dispatched = [];
  // Synthetic node store — keyed by the in-doc position we hand back from
  // `tr.insert`. Real ProseMirror would shift positions on every mutation;
  // for our test purposes (single insert → single replace/delete) the
  // simple monotonic counter below is sufficient.
  let nextPos = 100;
  const liveNodes = []; // [{from, to, node}]

  const makeImageNode = (attrs) => ({
    type: { name: 'image' },
    attrs: { ...attrs },
    nodeSize: 1,
  });

  const view = {
    state: {
      selection: { from: selectionFrom },
      schema: {
        nodes: {
          image: { create: (attrs) => makeImageNode(attrs) },
        },
      },
      doc: {
        descendants(cb) {
          for (const entry of liveNodes) {
            const stop = cb(entry.node, entry.from);
            if (stop === false) return;
          }
        },
      },
      get tr() {
        return {
          insert: (pos, node) => {
            const from = pos;
            const to = from + node.nodeSize;
            return {
              __intent: 'insert',
              __record: () => { liveNodes.push({ from, to, node }); },
              pos,
              node,
            };
          },
          replaceWith: (from, to, node) => ({
            __intent: 'replace',
            __record: () => {
              const idx = liveNodes.findIndex((n) => n.from === from);
              if (idx >= 0) liveNodes[idx] = { from, to: from + node.nodeSize, node };
            },
            from,
            to,
            node,
          }),
          delete: (from, to) => ({
            __intent: 'delete',
            __record: () => {
              const idx = liveNodes.findIndex((n) => n.from === from);
              if (idx >= 0) liveNodes.splice(idx, 1);
            },
            from,
            to,
          }),
        };
      },
    },
    dispatch: (tr) => {
      // Apply the synthetic mutation so subsequent doc.descendants finds
      // the right nodes, then record the dispatched transaction for the
      // test's assertions.
      if (typeof tr.__record === 'function') tr.__record();
      dispatched.push(tr);
      // For inserts, hand back a "position" the caller can stash.
      if (tr.__intent === 'insert') nextPos += tr.node.nodeSize;
    },
    posAtCoords: posAtCoords === null ? undefined : () => posAtCoords,
    dispatched,
  };
  return view;
}

function makeFile({
  name = 'sample.png',
  type = 'image/png',
  size = 1024,
} = {}) {
  return { name, type, size };
}

function makeClipboardEvent({ items = [] } = {}) {
  return {
    clipboardData: { items },
    preventDefault: vi.fn(),
  };
}

function makeDropEvent({ files = [], clientX = 0, clientY = 0 } = {}) {
  return {
    dataTransfer: { files },
    clientX,
    clientY,
    preventDefault: vi.fn(),
  };
}

/** Promise-flushing helper — handleImageUpload chains awaits inside the
 *  paste/drop handler so we need to let the microtask queue drain before
 *  asserting on dispatched transactions. */
async function flush() {
  // Multiple ticks to cover: uploadFn await → placeholder lookup →
  // dispatch. Each await yields to the microtask queue once.
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('image drop/paste plugin (Phase H-v2)', () => {
  let uploadFn;
  let onError;
  let plugin;
  let handlePaste;
  let handleDrop;

  beforeEach(() => {
    uploadFn = vi.fn(async (file) => ({ url: `https://cdn.example/${file.name}` }));
    onError = vi.fn();
    plugin = buildImageDropPastePlugin({ uploadFn, onError });
    handlePaste = plugin.props.handlePaste;
    handleDrop = plugin.props.handleDrop;
  });

  it('handlePaste ignores non-image clipboard items (returns false)', () => {
    const view = makeView();
    // Two string items + a binary that isn't an image-typed file.
    const event = makeClipboardEvent({
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'string', type: 'text/html', getAsFile: () => null },
        // A file but not image (e.g. application/pdf) — must be ignored.
        { kind: 'file', type: 'application/pdf', getAsFile: () => makeFile({ name: 'x.pdf', type: 'application/pdf' }) },
      ],
    });

    const handled = handlePaste(view, event);

    expect(handled).toBe(false);
    expect(uploadFn).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(view.dispatched).toHaveLength(0);
  });

  it('handlePaste intercepts an image clipboard item: uploads, inserts placeholder, then replaces with final image', async () => {
    const view = makeView();
    const file = makeFile({ name: 'paste.png', type: 'image/png', size: 5000 });
    const event = makeClipboardEvent({
      items: [
        { kind: 'file', type: 'image/png', getAsFile: () => file },
      ],
    });

    const handled = handlePaste(view, event);

    // Synchronous portion: handler returns true, placeholder is inserted,
    // preventDefault fired.
    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(view.dispatched[0].__intent).toBe('insert');
    expect(view.dispatched[0].node.attrs.src).toBeNull();
    expect(view.dispatched[0].node.attrs.title).toMatch(/^__uploading__:/);

    // Wait for uploadFn → replace transaction.
    await flush();

    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(uploadFn).toHaveBeenCalledWith(file);
    expect(view.dispatched[1].__intent).toBe('replace');
    expect(view.dispatched[1].node.attrs.src).toBe('https://cdn.example/paste.png');
    expect(view.dispatched[1].node.attrs.title).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('handleDrop intercepts an image file drop: uploads at the resolved position, inserts then replaces', async () => {
    const view = makeView({ selectionFrom: 1, posAtCoords: { pos: 42 } });
    const file = makeFile({ name: 'drop.jpg', type: 'image/jpeg', size: 9000 });
    const event = makeDropEvent({ files: [file], clientX: 100, clientY: 200 });

    const handled = handleDrop(view, event);

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // Placeholder insert dispatched at the resolved coords (pos: 42).
    expect(view.dispatched[0].__intent).toBe('insert');
    expect(view.dispatched[0].pos).toBe(42);

    await flush();

    expect(uploadFn).toHaveBeenCalledWith(file);
    expect(view.dispatched[1].__intent).toBe('replace');
    expect(view.dispatched[1].node.attrs.src).toBe('https://cdn.example/drop.jpg');
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects files larger than maxBytes — uploadFn NOT called, onError fires with size error', async () => {
    const smallMax = 1024; // 1 KB cap for this case
    const customPlugin = buildImageDropPastePlugin({ uploadFn, onError, maxBytes: smallMax });
    const customPaste = customPlugin.props.handlePaste;

    const view = makeView();
    const tooBig = makeFile({ name: 'huge.png', type: 'image/png', size: smallMax + 1 });
    const event = makeClipboardEvent({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => tooBig }],
    });

    const handled = customPaste(view, event);
    // Handler returns true (it DID claim the event — we don't want the
    // image to fall back to the browser's default paste behavior, which
    // would insert a base64 data: URL into the doc).
    expect(handled).toBe(true);
    await flush();

    expect(uploadFn).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const [err, errFile] = onError.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/too large/i);
    expect(errFile).toBe(tooBig);
    // No placeholder should be on the doc — the size check fires before insert.
    const inserts = view.dispatched.filter((d) => d.__intent === 'insert');
    expect(inserts).toHaveLength(0);
  });

  it('rejects disallowed MIME types — uploadFn NOT called, onError fires with type error', async () => {
    const view = makeView();
    // image/svg+xml is intentionally outside the allowlist — SVG can host
    // <script> payloads, so we never accept it.
    const svg = makeFile({ name: 'logo.svg', type: 'image/svg+xml', size: 500 });
    const event = makeClipboardEvent({
      items: [{ kind: 'file', type: 'image/svg+xml', getAsFile: () => svg }],
    });

    const handled = handlePaste(view, event);
    expect(handled).toBe(true);
    await flush();

    expect(uploadFn).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const [err, errFile] = onError.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/unsupported image type/i);
    expect(errFile).toBe(svg);
    // No insert dispatch — the MIME check fires before insert.
    const inserts = view.dispatched.filter((d) => d.__intent === 'insert');
    expect(inserts).toHaveLength(0);
  });

  it('uploadFn rejection removes the placeholder AND fires onError', async () => {
    const boom = new Error('S3 said no');
    uploadFn = vi.fn(async () => { throw boom; });
    onError = vi.fn();
    plugin = buildImageDropPastePlugin({ uploadFn, onError });
    handlePaste = plugin.props.handlePaste;

    const view = makeView();
    const file = makeFile({ name: 'fail.png', type: 'image/png', size: 2000 });
    const event = makeClipboardEvent({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
    });

    const handled = handlePaste(view, event);
    expect(handled).toBe(true);
    // Synchronous placeholder insert lands first.
    expect(view.dispatched[0].__intent).toBe('insert');

    await flush();

    // Upload was attempted with the file.
    expect(uploadFn).toHaveBeenCalledWith(file);
    // onError invoked with the rejection + the original File.
    expect(onError).toHaveBeenCalledWith(boom, file);
    // Placeholder was removed (delete transaction after the insert).
    const deletes = view.dispatched.filter((d) => d.__intent === 'delete');
    expect(deletes).toHaveLength(1);
    // No replace dispatch — the upload never produced a URL.
    const replaces = view.dispatched.filter((d) => d.__intent === 'replace');
    expect(replaces).toHaveLength(0);
  });
});
