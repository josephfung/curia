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
      // Legacy hand-rolled SPA lives at /old (served by knowledgeGraphRoutes,
      // not by Vite). Proxy the shell and its sub-paths so the old UI remains
      // accessible during development without needing a direct :3000 URL.
      '/old': 'http://localhost:3000',
      // Cytoscape and layout libraries are served by Fastify directly from
      // node_modules. Without these proxy entries the browser would request
      // them from the Vite dev server, which has no knowledge of those files.
      '/assets/cytoscape.min.js': 'http://localhost:3000',
      '/assets/layout-base.js': 'http://localhost:3000',
      '/assets/cose-base.js': 'http://localhost:3000',
      '/assets/cytoscape-fcose.js': 'http://localhost:3000',
    },
  },
});
