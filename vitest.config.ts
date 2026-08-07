import { defineConfig } from "vitest/config";

/**
 * Repo-level tests. These check things that span all packages (packaging and
 * resolution), as opposed to each package's own suite under js/<name>/tests.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
  },
});
