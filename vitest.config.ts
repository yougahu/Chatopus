import { defineConfig } from 'vitest/config';

// Runtime snapshots contain old checkouts and third-party test suites.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
