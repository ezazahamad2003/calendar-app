import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // tsconfig's `paths` is a compile-time concept; Vite resolves modules at
      // runtime and needs telling separately, or `@/…` imports in tests fail
      // with "Cannot find package".
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // The RLS suite shares one local Postgres and seeds fixtures in beforeAll.
    // Running files in parallel would race on that shared state.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
