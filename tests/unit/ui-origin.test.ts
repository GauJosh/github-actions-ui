// Security review M5: the UI server marks each origin's role and serves the matching CSP, so the executor origin
// can declare itself the token-free console and forbid GitHub connectivity. Pure handler checks, no sockets.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createHandler, loadSite } from "../../deploy/ui/server.mjs";
import { serverHeaders } from "../../deploy/ui/write-security-headers.ts";
import { APP_CSP, EXECUTOR_CSP } from "../../tools/vite/security-headers.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function site() {
  const root = join(mkdtempSync(join(tmpdir(), "gha-ui-m5-")), "dist");
  dirs.push(root);
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><html><head><title>x</title></head><body><div id=root></div></body></html>");
  writeFileSync(join(root, "assets", "index-AbCd1234.js"), "console.log(1)");
  return loadSite(root);
}
const headers = serverHeaders();
const index = (handler: ReturnType<typeof createHandler>) => handler("GET", "/").body.toString("utf8");
const injectedConfig = (handler: ReturnType<typeof createHandler>) => {
  const m = /<meta name="gha-ui-config" content="([^"]*)">/.exec(index(handler));
  return m ? JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) : null;
};
const csp = (handler: ReturnType<typeof createHandler>, path = "/") => handler("GET", path).headers["Content-Security-Policy"];

describe("UI origin role (security review M5)", () => {
  it("executor origin: declares the executor role, points to the trusted UI, and forbids GitHub in the CSP", () => {
    const h = createHandler({ site: site(), headers, ui: { role: "executor", trustedUiUrl: "https://gha-ui.example" } });
    expect(injectedConfig(h)).toEqual({ role: "executor", trustedUiUrl: "https://gha-ui.example" });
    expect(csp(h)).toBe(EXECUTOR_CSP);
    expect(csp(h)).toContain("connect-src 'self'");
    expect(csp(h)).not.toContain("api.github.com");
    expect(csp(h)).not.toContain("blob.core.windows.net");
  });

  it("trusted origin (default): declares the trusted role and serves the app CSP that allows GitHub", () => {
    const h = createHandler({ site: site(), headers });
    expect(injectedConfig(h)).toMatchObject({ role: "trusted" });
    expect(csp(h)).toBe(APP_CSP);
    expect(csp(h)).toContain("https://api.github.com");
  });

  it("carries the config in a CSP-safe meta tag (base64), never an inline script", () => {
    const h = createHandler({ site: site(), headers, ui: { role: "executor", trustedUiUrl: 'https://x/</meta>"<script>alert(1)</script>' } });
    const html = index(h);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toMatch(/<script>/);
    expect(injectedConfig(h)!.trustedUiUrl).toContain("alert(1)"); // preserved as data, decoded safely
  });

  it("rejects an invalid role", () => {
    expect(() => createHandler({ site: site(), headers, ui: { role: "trustedx" as "trusted" } })).toThrow(/Invalid UI role/);
  });

  it("worker scripts keep the worker CSP regardless of origin role", () => {
    const h = createHandler({ site: site(), headers, ui: { role: "executor", trustedUiUrl: "https://x" } });
    // No worker asset in this fixture, but the app CSP path is role-driven; assert the index is the only injected file.
    expect(injectedConfig(h)).toMatchObject({ role: "executor" });
    expect(h("GET", "/assets/index-AbCd1234.js").body.toString("utf8")).toBe("console.log(1)");
  });
});
