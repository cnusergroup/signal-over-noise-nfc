import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // The browser resolves the bare `three` specifier via lottery.html's
      // <importmap>; it is not installed in this test workspace. main.mjs only
      // touches `three` inside bootstrap() (never on the tested state-machine
      // paths), but Vite still resolves the dynamic import('three') string at
      // transform time, so alias it to a no-op stub so those modules load.
      three: fileURLToPath(new URL('./__mocks__/three.mjs', import.meta.url)),
    },
  },
  test: {
    globals: true,
    // Pure-math helpers (sphere positions, truncation) need no DOM; run in Node.
    environment: 'node',
    include: [
      '__tests__/**/*.test.mjs',
      '__tests__/**/*.property.test.mjs',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['*.mjs'],
    },
    testTimeout: 30000,
  },
});
