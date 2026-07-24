import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-oxc';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    // Injected at build time so the version from package.json is available
    // without a runtime fetch or a vite env file that needs manual updates.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    // Emit source maps only in development; production builds omit .map files
    // so internal implementation details are not publicly accessible via the
    // static file server.
    sourcemap: process.env['NODE_ENV'] !== 'production',
  },
  server: {
    fs: {
      // Serve only what the dev server actually needs from outside apps/console,
      // instead of the whole monorepo root (which would expose repo-root secrets
      // like .env via /@fs/) (#1514):
      //   - the console project root itself (and its symlinked node_modules)
      //   - the pnpm-hoisted dependency store at repo-root/node_modules
      //   - the single shared module the console imports: src/contacts/linkable-channels.ts
      allow: [
        import.meta.dirname,
        path.resolve(import.meta.dirname, '../../node_modules'),
        path.resolve(import.meta.dirname, '../../src/contacts'),
      ],
    },
    // In dev, proxy backend-served paths to the Fastify server on :3000.
    // This mirrors the production layout where Fastify serves everything from
    // the same origin.
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
    },
  },
});
