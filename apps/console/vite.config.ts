import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react-oxc';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bundleBuildId } from './vite-build-id.js';
const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

const envBuildId = process.env['CURIA_CONSOLE_BUILD_ID'];

function stampServiceWorkerSource(source: string, buildId: string): string {
  if (!source.includes('__BUILD_ID__')) {
    throw new Error('service worker is missing __BUILD_ID__');
  }
  return source.replaceAll('__BUILD_ID__', buildId);
}

function stampServiceWorker(): Plugin {
  const swPath = path.resolve(import.meta.dirname, 'public/sw.js');
  let buildId = envBuildId ?? 'dev';
  // The dev server also calls closeBundle when it shuts down. Only stamp after a real build,
  // or a stale dist/sw.js would be stamped twice and throw.
  let bundleGenerated = false;
  return {
    name: 'stamp-service-worker',
    generateBundle(_options, bundle) {
      if (!envBuildId) buildId = bundleBuildId(bundle, readFileSync(swPath, 'utf8'));
      bundleGenerated = true;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const urlPath = req.url?.split('?', 1)[0];
        if (urlPath !== '/sw.js') {
          next();
          return;
        }
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(stampServiceWorkerSource(readFileSync(swPath, 'utf8'), buildId));
      });
    },
    closeBundle() {
      if (!bundleGenerated) return;
      const built = path.resolve(import.meta.dirname, 'dist/sw.js');
      if (!existsSync(built)) return;
      writeFileSync(built, stampServiceWorkerSource(readFileSync(built, 'utf8'), buildId));
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    stampServiceWorker(),
  ],
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
        // The console imports the phone-docs URL constant from here.
        path.resolve(import.meta.dirname, '../../src/phone'),
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
