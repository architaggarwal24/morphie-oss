import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  plugins: [react()],
  // "@opennextjs/cloudflare" is the Workers runtime bridge; tests get a stand-in (see tests/helpers/cf-stub.ts).
  resolve: { alias: { "@opennextjs/cloudflare": path.resolve(root, "tests/helpers/cf-stub.ts"), "@": path.resolve(root, "src") } },
  test: { environment: "node", include: ["tests/**/*.test.{ts,tsx}"], setupFiles: ["tests/setup.ts"],
    // Windows starts every shell command through Git Bash, which is many times slower than on Linux/macOS: the
    // project and sandbox tests run hundreds of them, so they get more time there (the checks are the same).
    testTimeout: process.platform === "win32" ? 90_000 : 20_000 },
});
