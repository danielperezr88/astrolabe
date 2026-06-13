import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@astrolabe-dev/shared': resolve(__dirname, '../shared/dist/index.js'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Single worker — better-sqlite3 (synchronous C++ native addon)
    // deadlocks when multiple fork workers load it simultaneously.
    // singleFork=true prevents worker pool contention on WAL file locks.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Prevent vitest from processing the native module
    server: {
      deps: {
        external: ['better-sqlite3'],
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/*.d.ts'],
      thresholds: {
        lines: 20,
        branches: 15,
        functions: 15,
        statements: 20,
      },
    },
  },
});
