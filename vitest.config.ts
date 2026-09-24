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
      // Backend unit tests live under tests/unit/ (a mirror of src/). A src/**
      // glob would let co-located suites run again; tests/unit/src-test-layout.test.ts
      // rejects those files. Skill handler tests stay next to the skill, and app
      // tests stay in the app package.
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
