import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-oxc';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

export default defineConfig({
  base: '/antfarm/',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    sourcemap: process.env['NODE_ENV'] !== 'production',
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
    },
  },
});
