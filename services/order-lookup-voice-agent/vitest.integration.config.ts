import { defineConfig } from "vitest/config";

/** Opt-in durable / Postgres integration battery. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
