// Source of the stamp action. dist/index.js is its committed build output (plain JavaScript, no dependencies),
// which is what action.yml runs, as with any published JavaScript action.
import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";

function input(name: string): string {
  return (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) throw new Error("GITHUB_OUTPUT is not set");
  appendFileSync(file, `${name}=${value}\n`);
}

const version = input("version");
const key = input("signing-key");
if (!version || !key) {
  console.log("::error::version and signing-key are required");
  process.exit(1);
}
const stamp = `${version}+${createHmac("sha256", key).update(version).digest("hex").slice(0, 12)}`;
console.log(`Stamped ${version} as ${stamp}`);
setOutput("stamp", stamp);
