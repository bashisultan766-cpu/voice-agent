import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration suites are opt-in via `npm run test:integration`.
    exclude: ["node_modules/**", "dist/**", "tests/**/*.integration.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
