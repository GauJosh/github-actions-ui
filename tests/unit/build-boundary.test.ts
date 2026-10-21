// The production build boundary: ordinary builds contain no fixture mode, fault controls or fixture-server
// code, and ordinary `vite preview` mounts no fixture routes. A fixture-enabled build is the control case,
// proving the scan would detect them.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, resolveConfig } from "vite";
import { afterAll, describe, expect, it } from "vitest";

const CONFIG = "vite.config.ts";
const ENV = "GHA_UI_FIXTURES";

/** Strings that only fixture mode, fault injection or the fixture server would put in a bundle. */
const FORBIDDEN = [
  "__fixtures", // fixture API and index paths
  "?mode=fixtures", // demo-data link
  "Demo data", // fixture banner
  "fixture-faults", // fault switch
  "worker-failures", // fault switch value
  "inject-failure", // worker fault message
  "Injected worker failure",
  "Fixture mode blocked a request", // fixture transport
  "990000001", // synthetic fixture run
  "[synthetic]", // synthetic fixture labels
  "Demo gallery", // fixture-only gallery
  "Demo scenario", // fixture-only scenario strip
  "shared-workflows", // synthetic shared-workflow repository
  "action-cd-policy", // synthetic shared-workflow steps
  "fixtures.lock", // fixture server
  "gunzip",
  "raw.githubusercontent",
];

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function buildBundle(withFixtures: boolean): Promise<string> {
  const saved = process.env[ENV];
  if (withFixtures) process.env[ENV] = "1";
  else delete process.env[ENV];
  const outDir = mkdtempSync(join(tmpdir(), "gha-ui-build-"));
  dirs.push(outDir);
  try {
    await build({ configFile: CONFIG, logLevel: "silent", build: { outDir, emptyOutDir: true } });
  } finally {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  }
  return readdirSync(outDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
    .join("\n");
}

async function resolved(command: "serve" | "build", isPreview: boolean, withFixtures: boolean) {
  const saved = process.env[ENV];
  if (withFixtures) process.env[ENV] = "1";
  else delete process.env[ENV];
  try {
    const config = await resolveConfig({ configFile: CONFIG, logLevel: "silent" }, command, "production", "production", isPreview);
    return { plugins: config.plugins.map((p) => p.name), define: config.define?.__FIXTURE_MODE__, outDir: config.build.outDir };
  } finally {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  }
}

describe("production build boundary", () => {
  it("an ordinary production build contains no fixture mode, fault controls or fixture-server code", async () => {
    const bundle = await buildBundle(false);
    for (const marker of FORBIDDEN) expect(bundle, `production bundle contains "${marker}"`).not.toContain(marker);
    // The explicit unavailable state for ?mode=fixtures is kept, so the app never silently switches to live mode.
    expect(bundle).toContain("Fixture mode is not available in this build");
    // Live mode is intact.
    expect(bundle).toContain("api.github.com");
  }, 120_000);

  it("control: the explicit fixture test build does contain them", async () => {
    const bundle = await buildBundle(true);
    for (const marker of ["__fixtures", "fixture-faults", "inject-failure", "Fixture mode blocked a request"]) expect(bundle).toContain(marker);
  }, 120_000);

  it("ordinary preview mounts no fixture server; the explicit test preview does, serving dist-fixtures", async () => {
    const plain = await resolved("serve", true, false);
    expect(plain.plugins).not.toContain("gha-ui:fixture-server");
    expect(plain.define).toBe("false");
    expect(plain.outDir).toBe("dist");

    const test = await resolved("serve", true, true);
    expect(test.plugins).toContain("gha-ui:fixture-server");
    expect(test.define).toBe("true");
    expect(test.outDir).toBe("dist-fixtures");
  });

  it("the dev server keeps fixture mode for local development", async () => {
    const dev = await resolved("serve", false, false);
    expect(dev.plugins).toContain("gha-ui:fixture-server");
    expect(dev.define).toBe("true");
  });

  it("a production build without the explicit opt-in compiles fixture mode out", async () => {
    const prod = await resolved("build", false, false);
    expect(prod.plugins).not.toContain("gha-ui:fixture-server");
    expect(prod.define).toBe("false");
  });
});
