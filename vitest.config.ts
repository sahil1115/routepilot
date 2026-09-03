import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // Raised from the Phase 0 baseline of 10s at Phase 23, after chasing an
    // intermittent failure that appeared roughly once in five full-suite runs
    // and never once in isolation.
    //
    // It was never the same test twice. Every one that failed drives the whole
    // route pipeline several times over, and every one failed as a vitest
    // timeout rather than a failed assertion — so the cause is contention
    // between workers, not anything in the code. Fixing it per-test was tried
    // first and was wrong: it treated the slowest observed victim as the
    // problem, and the next run picked a different one.
    //
    // 30s is headroom for the runner, not permission for a test to be slow. The
    // whole suite still finishes in about 40 seconds.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.{test,spec}.ts'],
    },
  },
});
