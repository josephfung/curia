import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `.tsx` as well as `.ts` everywhere: `apps/**` was `.ts`-only, so
    // apps/console/src/pages/chat/VoiceCallBar.test.tsx existed and never ran — the same
    // silent-skip shape as #1726/#1727. Matching both extensions in every tree means a
    // component test added under packages/ later cannot go missing the same way.
    include: [
      'tests/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      'skills/**/*.test.{ts,tsx}',
      'apps/**/*.test.{ts,tsx}',
      'scripts/**/*.test.{ts,tsx}',
      'packages/**/*.test.{ts,tsx}',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
