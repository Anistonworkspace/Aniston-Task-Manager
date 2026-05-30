// Dedicated preload for the notification card BrowserWindow.
//
// This preload is a separate trust boundary from the main window's
// preload (`desktop/preload.js`). It exposes a tiny `window.notifBridge`
// surface — JUST the channels the card UI needs. The card UI loads
// a local file:// HTML page with a strict CSP; we never let arbitrary
// JS in the card reach ipcRenderer.
//
// Channels (all string-validated):
//   IN  notif-card:show     { id, title, body, url, iconUrl, sender, ts }
//   IN  notif-card:dismiss  { id }
//   IN  notif-card:clear
//   OUT notif-card:click    { id }
//   OUT notif-card:close    { id }
//   OUT notif-card:hover    { id, hovered: bool }
//   OUT notif-card:bounds   { width, height }
//
// nodeIntegration is OFF in the BrowserWindow this script preloads.
// contextIsolation is ON. The bridge is frozen so the in-page JS
// cannot replace its methods.

const { contextBridge, ipcRenderer } = require('electron');

let showCb = null;
let dismissCb = null;
let clearCb = null;

ipcRenderer.on('notif-card:show', (_event, payload) => {
  if (!showCb || !payload || typeof payload !== 'object') return;
  // Whitelist the payload shape so a future channel-misuse can't push
  // unknown fields into the renderer.
  const allowedThemes = new Set(['light', 'dark', 'auto']);
  const themeRaw = typeof payload.theme === 'string' ? payload.theme.toLowerCase() : '';
  const safe = {
    id: typeof payload.id === 'string' ? payload.id : null,
    title: typeof payload.title === 'string' ? payload.title : '',
    body: typeof payload.body === 'string' ? payload.body : '',
    url: typeof payload.url === 'string' ? payload.url : '',
    iconUrl: typeof payload.iconUrl === 'string' ? payload.iconUrl : '',
    sender: typeof payload.sender === 'string' ? payload.sender : '',
    ts: typeof payload.ts === 'string' ? payload.ts : '',
    theme: allowedThemes.has(themeRaw) ? themeRaw : 'light',
  };
  if (!safe.id || !safe.title) return;
  try { showCb(safe); } catch { /* swallow */ }
});

ipcRenderer.on('notif-card:dismiss', (_event, payload) => {
  if (!dismissCb || !payload || typeof payload.id !== 'string') return;
  try { dismissCb({ id: payload.id }); } catch { /* swallow */ }
});

ipcRenderer.on('notif-card:clear', () => {
  if (!clearCb) return;
  try { clearCb(); } catch { /* swallow */ }
});

contextBridge.exposeInMainWorld(
  'notifBridge',
  Object.freeze({
    onShow(cb) { if (typeof cb === 'function') showCb = cb; },
    onDismiss(cb) { if (typeof cb === 'function') dismissCb = cb; },
    onClear(cb) { if (typeof cb === 'function') clearCb = cb; },
    click(id) {
      if (typeof id !== 'string' || id.length === 0) return;
      ipcRenderer.send('notif-card:click', { id });
    },
    close(id) {
      if (typeof id !== 'string' || id.length === 0) return;
      ipcRenderer.send('notif-card:close', { id });
    },
    hover(id, hovered) {
      if (typeof id !== 'string' || id.length === 0) return;
      ipcRenderer.send('notif-card:hover', { id, hovered: !!hovered });
    },
    reportBounds(payload) {
      if (!payload || !Number.isFinite(payload.width) || !Number.isFinite(payload.height)) return;
      ipcRenderer.send('notif-card:bounds', {
        width: Math.max(0, Math.min(4000, Math.floor(payload.width))),
        height: Math.max(0, Math.min(4000, Math.floor(payload.height))),
      });
    },
  })
);
