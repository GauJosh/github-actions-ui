import { defineConfig, devices } from "@playwright/test";

const PORT = 4317;

// E2E runs against a fixture-enabled test build (GHA_UI_FIXTURES=1, output in dist-fixtures/) served by
// `vite preview`, so the production CSP headers are enforced. Ordinary production builds contain no fixture
// mode (tests/unit/build-boundary.test.ts). Live-mode tests mock api.github.com with page.route.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  workers: 1,
  // The JSON report keeps every failure (test, error, location) even when the terminal output is filtered or cut.
  reporter: [["list"], ["json", { outputFile: "playwright-report/results.json" }]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Safety net: the browser cannot resolve any host except the local preview server, so a request
        // that escapes a mock fails instead of reaching the internet. Mocked hosts are fulfilled by page.route.
        launchOptions: { args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] },
      },
    },
  ],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    env: { GHA_UI_FIXTURES: "1" },
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
