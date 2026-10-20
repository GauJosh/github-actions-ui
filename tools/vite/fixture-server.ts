import { resolve } from "node:path";
import type { Plugin } from "vite";
import { createFixtureMiddleware } from "../fixture-server/fixture-api.ts";

/** Serves fixture mode's local API in both `vite` (dev) and `vite preview`. */
export function fixtureServer(repoRoot: string): Plugin {
  const middleware = createFixtureMiddleware({ repoRoot, lockPath: resolve(repoRoot, "fixtures.lock.json") });
  return {
    name: "gha-ui:fixture-server",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
