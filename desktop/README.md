# Monday Aniston — Desktop wrapper

Electron shell for the Monday Aniston web app. Lets the existing React/Vite
frontend run as an installable Windows desktop application while sharing the
same backend at `https://monday.anistonav.com`.

This folder is **isolated**: it has its own `package.json` with `electron` as
the only dependency. The web app (`client/`) and the backend (`server/`) are
not affected by anything here.

## Slice 1 scope (delivered)

- Electron shell that opens a single window.
- Dev mode: loads `http://localhost:3000` (the Vite dev server).
- Packaged mode: loads `client/dist/index.html` and points API/socket at
  `https://monday.anistonav.com`.
- Strict security (`contextIsolation`, `nodeIntegration: false`, `sandbox`,
  preload bridge limited to the runtime config).
- Outgoing `Origin` header rewritten to `https://monday.anistonav.com` on
  packaged builds so the backend's CORS + origin-validation accept the
  requests and cookies bind to the production hostname.

## Slice 2 scope (delivered)

- **System tray icon** with tooltip and context menu.
- **Tray menu:** *Open Monday Aniston* · *Refresh* · *Quit Monday Aniston*.
- **Left-click / double-click** the tray icon to open or restore the window.
- **Close (X) → hide to tray** on Windows/Linux. The app keeps running in the
  background. macOS retains the platform-standard hide-window-but-stay-in-dock
  behavior.
- **Only the tray's "Quit" item exits the app fully** (or an OS shutdown / `Ctrl+Q`,
  both of which set the same `isQuitting` flag).
- **First-time balloon hint** appears once per launch on Windows the first
  time the user hides to tray, so it's clear the app didn't quit.
- **`backgroundThrottling: false`** on the renderer keeps socket.io's
  reconnect timers and the notification burst dispatcher running at full
  speed while the window is hidden.
- Single-instance lock + `second-instance` handler call `showMainWindow()`,
  so launching the app a second time un-hides the existing window instead
  of opening a duplicate.

### What works when the window is closed to tray

- Socket.io stays connected. The renderer process is still running, just
  not displayed.
- All real-time events (`notification:new`, `task:unblocked`, etc.) continue
  to arrive.
- The in-app toast still fires on those events (you just don't see it until
  you open the window — the browser-`Notification`-API foreground path also
  still runs and may show OS toasts depending on permission). **Slice 3
  replaces the in-tray notification path with native Electron notifications
  so the user sees a proper Windows toast even while the window is hidden.**

### What does NOT work when the app is fully quit

If the user picks **Quit** from the tray (or the process is killed), there
is no background service and no push-receiver running on the user's machine.
Socket.io requires a live process to receive events — once that's gone, no
new notifications can arrive until the user re-launches the app.

True "push notifications while killed" requires one of:
- A separate Windows background service that maintains the socket connection
  even when the GUI is closed; **or**
- Real Web Push delivery via the existing VAPID + service-worker pipeline,
  which on the desktop side needs the renderer's service worker active —
  not possible from a `file://`-loaded packaged frontend.

These options are out of scope for v1. They are listed in the Future
Improvements section of the slice-1 audit.

## Slice 3 scope (delivered)

- **Native Electron notifications** dispatched from the main process via a
  single IPC channel `aniston:notify`. Renderer keeps calling
  `showLocalNotification(...)` in [pushNotifications.js](../client/src/services/pushNotifications.js)
  — that helper now tries the desktop bridge first and falls back to the
  existing SW / `new Notification()` paths only on explicit failure.
- **Click action**: focuses the main window (restoring from tray if needed)
  and tells the renderer to navigate via the SPA-route path that came in the
  payload. Implemented via a second IPC channel `aniston:navigate` and the
  same `pushState + popstate` mechanic the existing service-worker NAVIGATE
  handler uses, so React Router re-resolves the location with no full reload.
- **Strict input validation** in both `preload.js` (renderer-side clamp) and
  `notifications.js` (main-process re-validation). URLs must be relative SPA
  paths (`/boards/...`, `/my-work?...`); `file://`, `javascript:`, external
  `https://` are rejected. Title and body are control-character-scrubbed and
  length-clamped.
- **Dedup** by `notif-<id>` tag with a 3-second window inside the main
  process, on top of the renderer's own 1500ms burst-dispatcher window.
- **Service worker registration skipped** when running inside Electron
  (`isDesktopApp()` short-circuits the gate in [client/src/main.jsx](../client/src/main.jsx)).
  The web build is unaffected; only the desktop runtime sees the change.
- **VAPID `subscribeToPush()` skipped** in *packaged* desktop builds —
  there's no SW to host the subscription, and the OS notification path
  replaces it. Dev desktop still attempts a subscribe so the failure mode
  is the same as it would be in a browser; the helper handles it gracefully.

### Notification payload contract

```ts
window.anistonDesktop.notify({
  title: string,            // <= 200 chars
  body: string,             // <= 500 chars
  tag?: string,             // <= 200 chars; dedup key
  url?: string,             // SPA path beginning with "/"; <= 1000 chars
}): Promise<{ ok: boolean, deduped?: boolean, reason?: string }>
```

Returns synchronously on the renderer side (Promise resolves immediately
after the main process responds). The OS notification render and the user
click are asynchronous events handled separately.

### Click flow

1. Renderer calls `showLocalNotification('Task assigned', { body, tag: 'notif-<id>', url: '/boards/<bid>?taskId=<tid>' })`.
2. `pushNotifications.js` detects desktop runtime and IPC-invokes `aniston:notify`.
3. Main process re-validates, fires `new Notification(...)`, attaches a
   `click` handler that captures the URL.
4. OS shows the Windows toast (and adds it to Action Center).
5. User clicks the toast (now or hours later from Action Center).
6. Main process: `showMainWindow()` (restores from tray, focuses) + sends
   `aniston:navigate` to the renderer.
7. Renderer preload's `ipcRenderer.on` fires the registered `onNavigate`
   callback, which `pushState`s the URL and dispatches a `popstate`.
8. React Router picks up the new location and renders the target route.

If the renderer was destroyed at step 5 (rare — only on renderer crash +
tray-Open), the preload buffers the URL and replays it once `onNavigate`
re-registers. If the new window is still loading, `navigateRenderer()` in
[main.js](main.js) defers the send to `did-finish-load`.

## Slice 5 scope (delivered — config ready; build needs a one-time env unblock)

- **`electron-builder` config** added to `desktop/package.json` under the
  `build` key. Targets Windows NSIS installer with the artefact name
  `Monday-Aniston-Setup.exe` (per the original requirement).
- **`AppUserModelId`** `com.aniston.monday` set before any window or
  notification is created. Windows uses this stable id for toast grouping,
  taskbar pinning, and future toast action buttons. Changing it later would
  orphan existing user shortcuts; do not rename casually.
- **`desktop/paths.js` helper** unifies icon + index.html path resolution.
  In a real packaged build, paths resolve through `process.resourcesPath/`
  (where electron-builder's `extraResources` deposits the React bundle and
  icons). In dev / `ANISTON_FORCE_PROD=1` mode, paths fall back to the
  in-repo `client/dist/` and `client/public/icons/`. Used by `main.js`,
  `tray.js`, and `notifications.js`.
- **Per-user install** (`nsis.perMachine: false`) — no UAC admin prompt at
  install time. Lives under `%LOCALAPPDATA%\Programs\Monday Aniston\`.
  Easier for non-admin employees.
- **Installer wizard** (`nsis.oneClick: false`) — proper Windows
  install/uninstall wizard with directory choice. Creates Start Menu +
  Desktop shortcuts named "Monday Aniston". Launches the app after install.
- **`deleteAppDataOnUninstall: false`** — preserve user data on uninstall
  (cookies, session, settings). Safer default.
- **`desktop:dist` root script** chains the desktop client build and
  electron-builder in one go.

### One-time prerequisite on Windows (read before first build)

`electron-builder` downloads a tool bundle called `winCodeSign` that contains
macOS `.dylib` symlinks. Extracting those symlinks on Windows requires
`SeCreateSymbolicLinkPrivilege`, which is granted to Administrators by
default and to all users only when **Developer Mode** is enabled. Without
either, you'll see `ERROR: Cannot create symbolic link` during the very
first run of `electron-builder`. This is a known electron-builder issue,
not specific to our config.

**Choose one (one-time setup):**

1. **Enable Windows Developer Mode** (recommended, no admin shell needed
   for subsequent builds):
   `Settings → Privacy & security → For developers → Developer Mode = On`.
   That grants the privilege to your user account permanently.

2. **OR run the build once from an elevated PowerShell**:
   right-click PowerShell → *Run as administrator* → re-run
   `npm run desktop:dist`. After the first successful build the
   `winCodeSign` cache (at `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\`)
   is populated and subsequent builds don't need admin.

Once unblocked, you can build normally from any PowerShell prompt — the
config is correct and reproducible.

### Build commands

```powershell
# One-time: install the desktop-side dependencies (electron + electron-builder)
npm run desktop:install                # from repo root

# Each build: produce the Windows EXE installer
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run desktop:dist                   # builds client (desktop mode) + EXE

# Output: desktop\dist\Monday-Aniston-Setup.exe   (~70-90 MB)
```

### Installing the EXE (end-user experience)

1. Double-click `Monday-Aniston-Setup.exe`.
2. **Windows SmartScreen will warn** because we don't yet code-sign. Click
   "More info" → "Run anyway." This warning goes away once we ship with a
   real EV/OV code-signing certificate (future improvement, not in v1).
3. Installer wizard appears: choose install location (or accept the default
   `%LOCALAPPDATA%\Programs\Monday Aniston\`).
4. After install completes the app launches automatically.
5. Start Menu entry and Desktop shortcut are both created (named "Monday
   Aniston").

### Uninstalling

`Settings → Apps → Installed apps → Monday Aniston → Uninstall`. The
uninstaller preserves user data (cookies, local preferences) under
`%APPDATA%\Monday Aniston\` so re-install picks up the previous session.
Manual wipe: delete that folder.

### Bumping the version

The version comes from `desktop/package.json`. Bump that, rebuild, and
electron-builder picks it up for the installer metadata (also affects the
uninstaller's displayed name `Monday Aniston <version>`).

```jsonc
// desktop/package.json
{
  "version": "1.2.0",   // bump as needed
  ...
}
```

## Slice 5b scope (delivered — app-hosted installer download)

- **`/api/desktop/download`** — authenticated GET that streams the latest
  Windows installer EXE. Auth: any logged-in user (`authenticate` middleware
  only — no tier/permission gate in v1). The endpoint is intentionally NOT a
  static file mount; going through a controller lets us add per-tier
  rollouts later without re-plumbing storage.
- **`/api/desktop/manifest`** — authenticated GET returning JSON metadata
  about the currently published installer. Shape:
  ```json
  {
    "version": "1.1.0",
    "platform": "win32",
    "installerUrl": "https://monday.anistonav.com/api/desktop/download",
    "releaseNotes": "...",
    "mandatory": false,
    "publishedAt": "2026-05-16T12:07:11.138Z",
    "sizeBytes": 83257978
  }
  ```
  Used by the web profile dropdown to decide whether to surface the
  "Download Desktop App" item. Future auto-update checks will read the
  same endpoint.
- **`Download Desktop App` profile-menu item** in the web client. Hidden on
  the desktop app (the user already has the installer) and hidden on the
  web when the manifest endpoint returns 404 (nothing published yet). Uses
  a plain `<a download href="/api/desktop/download">` so the browser handles
  streaming + native download progress.
- **Storage**: `server/downloads/desktop/Monday-Aniston-Setup.exe` +
  `server/downloads/desktop/desktop-update.json`. Both gitignored; the
  directory is committed via `.gitkeep` so a fresh clone has the path
  available even before `npm run desktop:publish` runs.
- **`npm run desktop:publish`** — copies `desktop/dist/Monday-Aniston-Setup.exe`
  into `server/downloads/desktop/` and writes the manifest. Reads `version`
  from `desktop/package.json`. Optional `--release-notes="..."` and
  `--mandatory` flags. Deliberately separate from `desktop:dist` so a
  developer can build locally and verify the installer before exposing the
  new version to users.

### End-to-end ship workflow

```powershell
# 1. Build + verify the installer locally
npm run desktop:dist
# 2. (Optional) install it on your own machine to smoke-test
desktop\dist\Monday-Aniston-Setup.exe
# 3. Publish into server storage when ready
npm run desktop:publish -- --release-notes="What changed in this build"
# 4. Commit + deploy the server. The new manifest + EXE roll out with the
#    next backend deploy because they live under server/downloads/desktop/
#    which is part of the backend container image.
```

### Why app-hosted instead of S3 / CDN / GitHub Releases?

Per v1 ops constraint: no external storage platforms yet. The EXE lives
inside the backend container under `server/downloads/desktop/`. Trade-offs:

- (+) Single deploy pipeline ships both code and installer.
- (+) Auth-gated by default — only employees can grab the EXE.
- (+) No new IAM / S3 bucket / CDN config to manage.
- (-) The 83 MB file ships with every backend container build, growing
  image size. Acceptable until we cross ~250 MB total.
- (-) No CDN edge caching — every download streams from the EC2 instance.
  Fine for ~50 employees; revisit if we scale to thousands.

When (if) the operational shape changes — bigger company, multi-region,
public download page — we lift this to S3 + CloudFront and keep the
controller as a thin redirect to a signed URL. The dropdown URL doesn't
need to change because the manifest's `installerUrl` is the single source
of truth.

## Not yet implemented

- Auto-launch on Windows login (a future per-user toggle).
- Code signing (the v1 installer is unsigned — Windows SmartScreen warning
  on first install is expected; documented above).
- Auto-updater (`electron-updater`) — manifest endpoint is ready; the
  desktop app does NOT yet consume it.
- Unread-count badge overlay on the tray icon.
- Windows Toast action buttons / inline reply (requires shipped Toast XML
  templates on top of the AppUserModelId already in place).
- sha256 / signature field in the manifest — wait until code signing lands.

## How to run

Install desktop dependencies once:

```powershell
cd desktop
npm install
```

### Dev mode (against the local Vite dev server)

In one terminal, start the existing web dev stack:

```powershell
npm run dev          # from repo root — starts both server (5000) and client (3000)
```

In a second terminal:

```powershell
npm run desktop:dev  # from repo root — launches Electron at http://localhost:3000
```

The window will retry every second if Vite isn't ready yet, so the order doesn't
strictly matter.

### Simulate the packaged production config without packaging

```powershell
cd client && npm run build -- --mode desktop   # builds with base: './'
$env:ANISTON_FORCE_PROD = "1"                  # PowerShell — sets the flag for one shell
cd ..\desktop && npm start
```

The window loads `client/dist/index.html` from disk and points API/Socket at
`https://monday.anistonav.com`. Useful for verifying the production URL config
without producing a real installer.

## Files

| File | Purpose |
|---|---|
| `main.js` | Electron main process — window, security, navigation lockdown, origin rewrite, close-to-tray lifecycle, IPC handlers, AppUserModelId |
| `preload.js` | Exposes `window.anistonDesktop` (frozen) — config, `notify()`, `onNavigate()` |
| `runtimeConfig.js` | Resolves API + socket URLs from `app.isPackaged` and env-var overrides |
| `paths.js` | Slice-5: resolves icon + index.html paths through `process.resourcesPath` when packaged, in-repo paths otherwise |
| `tray.js` | System tray icon, context menu, hide-to-tray balloon hint |
| `notifications.js` | Native Electron `Notification` wrapper with validation, dedup, click handler |
| `package.json` | Electron + electron-builder devDeps; isolated from `client/` and `server/`. Contains the electron-builder `build` config (NSIS target, AppId, AppUserModelId, extraResources) |

## Environment variables (dev only)

| Var | Default | Purpose |
|---|---|---|
| `ANISTON_API_URL` | `http://localhost:5000/api` | Override dev API base URL |
| `ANISTON_SOCKET_URL` | `http://localhost:5000` | Override dev socket URL |
| `ANISTON_FORCE_PROD` | unset | If `"1"`, treat as packaged build (loads `client/dist/index.html` and uses production URLs). Useful for testing the production config without producing an installer |

None of these have any effect once the app is packaged — packaged builds are
hard-wired to `https://monday.anistonav.com`.
