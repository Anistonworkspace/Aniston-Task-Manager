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
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:5000',
        changeOrigin: true,
        ws: true,
      },
      '/uploads': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
}));
