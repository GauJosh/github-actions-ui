import { readFileSync } from "node:fs";
import { NOT_PREPARED, verifyFixtures } from "../../tools/fixtures/fixtures.ts";
import { parseLock } from "../../tools/fixtures/lockfile.ts";

/** Fixture-dependent E2E tests fail (never skip) when the pinned fixtures are missing or altered. */
export default function globalSetup(): void {
  const problems = verifyFixtures(parseLock(readFileSync("fixtures.lock.json", "utf8")), ".fixtures");
  if (problems.length) throw new Error(`${NOT_PREPARED}\n${problems.slice(0, 5).join("\n")}`);
}
