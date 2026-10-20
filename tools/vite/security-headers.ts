// Content Security Policy for the production build served by `vite preview` (docs/ARCHITECTURE.md §7.3).
// The dev server is not covered: its hot-reload client needs inline scripts and a websocket.
import type { Plugin } from "vite";

/**
 * `*.blob.core.windows.net` is the narrowest rule that works for GitHub's log redirects (17 accounts seen
 * in 30 samples). It still permits any Azure Blob account: a known residual risk with compensating controls.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://api.github.com https://*.blob.core.windows.net",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The log worker holds log text and must never make network requests. */
export const WORKER_CSP = "default-src 'none'; script-src 'self'; connect-src 'none'";

export const isWorkerScript = (path: string) => /^\/assets\/log-worker-[\w-]+\.js$/.test(path);

export function securityHeaders(): Plugin {
  return {
    name: "gha-ui:security-headers",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "/").split("?")[0]!;
        res.setHeader("Content-Security-Policy", isWorkerScript(path) ? WORKER_CSP : APP_CSP);
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Content-Type-Options", "nosniff");
        next();
      });
    },
  };
}
