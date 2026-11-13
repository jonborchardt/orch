import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// Built assets land in web/dist and are served by `orch ui` (src/server/http.ts).
// `npm run web:dev` runs this dev server and proxies /api to a running `orch ui`.
export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4777' },
  },
});
