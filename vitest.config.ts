import { defineConfig } from "vitest/config";

// Only the TypeScript sources: `npm run build` also emits compiled copies of
// the tests under dist/.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
