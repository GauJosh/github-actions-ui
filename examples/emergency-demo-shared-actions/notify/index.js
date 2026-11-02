"use strict";
// A dependency-free JavaScript action: reads its input, prints a notice and sets an output.
const { appendFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");

const message = (process.env.INPUT_MESSAGE ?? "").trim();
if (!message) {
  console.log("::error::message is required");
  process.exit(1);
}
console.log(`::notice title=Notify::${message}`);
const delimiter = `ghadelimiter_${randomUUID()}`;
appendFileSync(process.env.GITHUB_OUTPUT, `sent<<${delimiter}\n${message}\n${delimiter}\n`);
