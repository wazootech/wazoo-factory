import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// @/ mirrors the tsconfig path alias so test resolution matches app code.
const root = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
    },
  },
  test: {
    include: ["tests/**/*_test.ts"],
  },
});
