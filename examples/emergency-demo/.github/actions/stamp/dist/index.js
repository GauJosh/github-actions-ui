"use strict";
// Build output of ../src/index.ts (TypeScript compiled to CommonJS by hand-equivalent transpilation; no dependencies).
const { createHmac } = require("node:crypto");
const { appendFileSync } = require("node:fs");

function input(name) {
  return (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

function setOutput(name, value) {
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
