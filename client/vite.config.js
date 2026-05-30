import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// Plugin to inject build timestamp into sw.js so each build triggers SW update
function swVersionPlugin() {
  return {
    name: 'sw-version',
    writeBundle() {
      const swPath = path.resolve(__dirname, 'dist', 'sw.js');
      if (fs.existsSync(swPath)) {
        let content = fs.readFileSync(swPath, 'utf-8');
        content = content.replace('__BUILD_TIMESTAMP__', Date.now().toString());
        fs.writeFileSync(swPath, content);
      }
    },
  };
}

// `base` controls the URL prefix Vite bakes into index.html for asset
// references. On the web (served by nginx at https://monday.anistonav.com/),
// the default '/' is correct — deep-link visits to /boards/123 still resolve
// /assets/foo.js to the same absolute path. The packaged Electron app loads
// index.html via file:///<install>/resources/client-dist/index.html, where
// '/assets/foo.js' resolves to file:///C:/assets/foo.js (drive root) and
// 404s. Setting base to './' for the desktop build makes asset paths
// relative to index.html ('./assets/foo.js' → file:///<dir>/assets/foo.js),
// which is what the file:// loader can actually read. Trigger the desktop
// variant with: `vite build --mode desktop`.
export default defineConfig(({ mode }) => ({
  base: mode === 'desktop' ? './' : '/',
  plugins: [react(), swVersionPlugin()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: true,
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    // Bumped from the 5s vitest default + the 1s testing-library default
    // because the full 73-file suite under heavy parallel load produces
    // CI runs that occasionally take ~80s instead of the usual ~50s.
    // Individual `waitFor` calls without explicit timeouts (~210 sites)
    // were inheriting the 1s default and intermittently failing on the
    // slow runs — root cause of the May-17 transient "1 failed / 696
    // passed" flake. 8s gives plenty of slack without masking real bugs.
    testTimeout: 10000,
  },
  server: {
    port: 3000,
    // Docker Desktop on Windows does not forward host filesystem events
    // (inotify) into the Linux container over bind mounts, so Vite's native
    // watcher never sees edits and HMR silently stops working — you'd have to
    // restart the container to pick up changes. When running in the dev
    // container we set CHOKIDAR_USEPOLLING=true (see docker-compose.dev.yml)
    // to switch chokidar to polling. Native host dev (`npm run dev` on
    // Windows directly) leaves this unset and keeps fast event-based watching.
    // Polling interval is deliberately high (1000ms, not the chokidar 100ms
    // default). Docker Desktop's Windows bind mount (gRPC-FUSE) makes each
    // fs.stat cost ~30-40ms instead of microseconds. Vite polls ~500 source
    // files, so a tight interval pegs all libuv threads on stat() forever and
    // starves Vite's own reads — pages and proxied /api responses then stall
    // for seconds. A 1s interval plus a large UV_THREADPOOL_SIZE (set in
    // docker-compose.dev.yml) keeps the watcher cheap while leaving threads
    // free to serve. HMR still picks up edits within ~1s.
    watch:
      process.env.CHOKIDAR_USEPOLLING === 'true'
        ? { usePolling: true, interval: 1000, binaryInterval: 2000 }
        : undefined,
    proxy: {
      // timeout / proxyTimeout cap how long a single proxied request may hang
      // waiting to connect to, or receive a response from, the backend. Without
      // them, if the backend is briefly unavailable (e.g. a nodemon reboot in
      // the Docker dev stack), failed/pending sockets accumulate in http-proxy's
      // agent until the proxy wedges and every /api call hangs ~indefinitely —
      // the frontend then sits on skeleton loaders forever. Failing fast (8s)
      // lets the browser's own retries recover once the backend is back.
      '/api': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
        timeout: 8000,
        proxyTimeout: 8000,
      },
      '/socket.io': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:5000',
        changeOrigin: true,
        ws: true,
      },
      '/uploads': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:5000',
        changeOrigin: true,
        timeout: 30000,
        proxyTimeout: 30000,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
}));
