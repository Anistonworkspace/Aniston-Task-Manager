// Resolves the API and Socket.io URLs that the renderer will use.
//
// Packaged build (app.isPackaged === true OR ANISTON_FORCE_PROD=1)
//   apiBaseUrl = https://monday.anistonav.com/api
//   socketUrl  = https://monday.anistonav.com
//
// Development build (Electron launched against the local Vite dev server)
//   apiBaseUrl = http://localhost:5000/api      (or ANISTON_API_URL override)
//   socketUrl  = http://localhost:5000          (or ANISTON_SOCKET_URL override)
//
// The env-var overrides exist for slice-1 testing only — they let a developer
// point a non-packaged Electron build at a staging or remote backend without
// recompiling. They have no effect once the app is packaged: production EXEs
// are hard-coded to monday.anistonav.com by design (the user requirement is
// "final EXE must not depend on localhost").

const PROD = Object.freeze({
  apiBaseUrl: 'https://monday.anistonav.com/api',
  socketUrl: 'https://monday.anistonav.com',
});

function devConfig() {
  return Object.freeze({
    apiBaseUrl: process.env.ANISTON_API_URL || 'http://localhost:5000/api',
    socketUrl: process.env.ANISTON_SOCKET_URL || 'http://localhost:5000',
  });
}

function resolveConfig(isPackaged) {
  if (isPackaged || process.env.ANISTON_FORCE_PROD === '1') return PROD;
  return devConfig();
}

module.exports = { resolveConfig, PROD };
