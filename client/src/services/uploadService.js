// Doc Editor Phase H-v2 — small client wrapper around the existing
// `/api/files/upload-general` endpoint. Lets the RichTextEditor's
// image-drop/-paste plugin upload an inline image without requiring a
// parent taskId (the `POST /api/files` task-attachment route does).
//
// The wrapper intentionally lives in `services/` rather than as a closure
// inside RichTextEditor.jsx so callers (DocPage, NotesPage, TaskModal —
// anywhere that wires up `buildImageExtension({ uploadFn })`) can share
// the same upload helper and so the test suite can import and exercise
// it independently of Tiptap.
//
// API contract (confirmed by reading server/controllers/fileController.js
// `uploadGeneral`):
//   POST /api/files/upload-general (multipart, field name `file`)
//   → 200 { success: true, data: { url, filename, originalName, size,
//                                   mimetype, provider, category } }
//   The Axios response interceptor in `services/api.js` auto-spreads
//   `response.data.data` into `response.data`, so callers can read
//   `res.data.url` directly. We still defensively look at both shapes so
//   the helper works regardless of whether the interceptor stays in place.

import api from './api';

/**
 * Upload an image File to the general-purpose attachment endpoint and
 * return its resolved URL + storage filename. Throws on network or
 * server error so the editor plugin's `try/catch` can run the placeholder
 * cleanup and `onError` callback.
 *
 * @param {File} file  Browser File from drag-drop or clipboard paste
 * @returns {Promise<{ url: string, filename: string }>}
 */
export async function uploadInlineImage(file) {
  if (!file) throw new Error('uploadInlineImage: file is required');

  const form = new FormData();
  form.append('file', file);
  // Hint the server this is an inline doc image so future logic can route
  // it into a dedicated category folder if needed. Today the server
  // ignores the `context` field for upload-general; we send it anyway so
  // a follow-up backend slice doesn't require a client redeploy.
  form.append('context', 'doc-inline-image');

  const res = await api.post('/files/upload-general', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });

  // `data.data` shape: the raw server payload before the interceptor.
  // `data` (top-level) shape: post-interceptor spread (the common case in
  // this app). `data.file` shape: tolerated for callers that one day flip
  // this to the task-attachment endpoint.
  const payload = res?.data?.data ?? res?.data ?? {};
  const url = payload.url || payload.file?.url || null;
  const filename = payload.filename || payload.file?.filename || null;

  if (!url) {
    throw new Error('uploadInlineImage: server response did not include a url');
  }

  return { url, filename };
}

export default uploadInlineImage;
