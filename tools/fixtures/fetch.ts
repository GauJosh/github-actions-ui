// Usage: node tools/fixtures/fetch.ts [--from <path-to-local-clone>] [--lock fixtures.lock.json] [--out .fixtures]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cloneSource, fetchFixtures, fixtureDir, httpSource } from "./fixtures.ts";
import { FixtureError, parseLock } from "./lockfile.ts";

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    lock: { type: "string", default: "fixtures.lock.json" },
    out: { type: "string", default: ".fixtures" },
  },
});

try {
  const lock = parseLock(readFileSync(values.lock, "utf8"));
  const source = values.from ? cloneSource(lock, values.from) : httpSource(lock);
  console.log(`fixtures: ${lock.files.length} files from ${source.describe}`);
  const { fetched, skipped } = await fetchFixtures({ lock, outRoot: values.out, source });
  console.log(`fixtures: ok (${fetched} written, ${skipped} already present) in ${fixtureDir(values.out, lock)}`);
} catch (error) {
  if (!(error instanceof FixtureError)) throw error;
  console.error(`fixtures: FAILED: ${error.message}`);
  process.exit(1);
}
