import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-oxc';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Emit source maps only in development; production builds omit .map files
    // so internal implementation details are not publicly accessible via the
    // static file server.
    sourcemap: process.env['NODE_ENV'] !== 'production',
  },
  server: {
    // In dev, proxy backend-served paths to the Fastify server on :3000.
    // This mirrors the production layout where Fastify serves everything from
    // the same origin.
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
    },
  },
});
