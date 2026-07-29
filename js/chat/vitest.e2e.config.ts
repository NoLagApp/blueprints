import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env.test without a dotenv dependency (wrapper packages don't ship one).
try {
  const env = readFileSync(resolve(__dirname, '.env.test'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  // no .env.test — the E2E suite self-skips without credentials
}

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    globals: true,
  },
});
