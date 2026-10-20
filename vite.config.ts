import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { fixtureServer } from "./tools/vite/fixture-server.ts";
import { securityHeaders } from "./tools/vite/security-headers.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

/** Explicit opt-in for a fixture-enabled build and preview server (used by the Playwright config only). */
export const FIXTURE_BUILD_ENV = "GHA_UI_FIXTURES";

export default defineConfig(({ command, isPreview }) => {
  const testBuild = process.env[FIXTURE_BUILD_ENV] === "1";
  // Fixture mode is compiled in for the dev server and unit tests, and for an explicitly requested test build.
  // Ordinary production builds and ordinary `vite preview` have no fixture code and no fixture routes.
  const fixtures = (command === "serve" && !isPreview) || testBuild;
  return {
    plugins: [react(), securityHeaders(), ...(fixtures ? [fixtureServer(root)] : [])],
    define: { __FIXTURE_MODE__: JSON.stringify(fixtures) },
    // A fixture-enabled build goes to its own folder so it cannot be mistaken for a production build.
    build: { target: "es2022", outDir: testBuild ? "dist-fixtures" : "dist" },
    worker: { format: "es" },
    test: {
      include: ["src/**/*.test.{ts,tsx}", "tools/**/*.test.ts", "tests/unit/**/*.test.ts"],
      setupFiles: ["./tests/unit/network-guard.ts"],
    },
  };
});
