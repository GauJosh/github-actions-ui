import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "dist-fixtures/", "node_modules/", ".fixtures/", "coverage/", "playwright-report/", "test-results/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["*.config.{js,ts}", "tools/**/*.{js,ts}", "tests/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  // Module boundaries (docs/ARCHITECTURE.md §4).
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["../*", "react", "react-dom", "@tanstack/*"], message: "src/domain is pure: no UI, network, auth or log imports." }] },
      ],
      "no-restricted-globals": ["error", "fetch", "window", "document", "localStorage", "sessionStorage", "indexedDB"],
    },
  },
  {
    // Only the GitHub transport may call fetch for GitHub data (fixture-mode UI reads its local index separately).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/github/transport.ts", "src/fixture-mode/FixtureIndex.tsx", "src/**/*.test.ts"],
    rules: { "no-restricted-globals": ["error", "fetch", "localStorage", "sessionStorage", "indexedDB"] },
  },
  {
    // Only the auth module and the environment wiring may touch the PAT provider.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/auth/**", "src/github/transport.ts", "src/app/environment.ts", "src/ui/ConnectView.tsx", "src/ui/App.tsx", "src/**/*.test.ts"],
    rules: { "no-restricted-imports": ["error", { paths: [{ name: "../auth/pat-provider", message: "Only auth wiring may use the token provider." }] }] },
  },
);
