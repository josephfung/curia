import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    // In dev, proxy API and auth calls to the Fastify backend on :3000.
    // This avoids CORS issues and mirrors the production setup where both
    // the static files and API are served from the same origin.
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
    },
  },
});
