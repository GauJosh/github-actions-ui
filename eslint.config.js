import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Note on ordering: for the same rule, a later matching block replaces an earlier one. The general `src`
// rules come first and the stricter `src/domain` block last, so the domain block keeps every restriction.
export default tseslint.config(
  { ignores: ["dist/", "dist-fixtures/", "review-screenshots/", "node_modules/", ".fixtures/", "coverage/", "playwright-report/", "test-results/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["*.config.{js,ts}", "tools/**/*.{js,ts}", "tests/**/*.ts", "deploy/**/*.{mjs,ts}"],
    languageOptions: { globals: globals.node },
  },
  // Module boundaries (docs/ARCHITECTURE.md §4).
  {
    // Only the GitHub transport may call fetch for GitHub data (the fixture-only demo gallery reads its own
    // local index); nothing persists to browser storage.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/github/transport.ts", "src/fixture-mode/gallery.tsx", "src/**/*.test.ts"],
    rules: { "no-restricted-globals": ["error", "fetch", "localStorage", "sessionStorage", "indexedDB"] },
  },
  {
    // Only the auth module and the environment wiring may touch the PAT provider (any relative path).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/auth/**", "src/github/transport.ts", "src/app/environment.ts", "src/ui/ConnectView.tsx", "src/ui/App.tsx", "src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: "(^|/)auth/pat-provider$", message: "Only auth wiring may use the token provider." }] }],
    },
  },
  {
    // src/domain is pure: no UI, network, auth, log or app imports, and no browser globals.
    files: ["src/domain/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)(ui|github|logs|auth|app|runs|fixture-mode)(/|$)|^react(-dom)?$|^@tanstack/",
              message: "src/domain is pure: no UI, network, auth or log imports.",
            },
          ],
        },
      ],
      "no-restricted-globals": ["error", "fetch", "window", "document", "localStorage", "sessionStorage", "indexedDB"],
    },
  },
);
