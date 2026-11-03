// Security review M5: the snapshot bundle a user carries from the trusted origin to the executor console as a file.
import { describe, expect, it } from "vitest";
import { readSnapshotFile } from "./snapshot-file.ts";

const bundle = { manifest: { name: "demo", files: [] }, contents: { abc: "AAA=" } };
const file = (text: string) => new File([text], "s.json", { type: "application/json" });

describe("readSnapshotFile", () => {
  it("reads a bundle the trusted origin exported", async () => {
    const r = await readSnapshotFile(file(JSON.stringify({ format: "gha-emergency-snapshot/1", ...bundle })));
    expect(r).toEqual(bundle);
  });

  it("rejects a file that is not a snapshot export", async () => {
    await expect(readSnapshotFile(file("not json"))).rejects.toThrow(/not valid JSON/);
    await expect(readSnapshotFile(file(JSON.stringify({ manifest: {}, contents: {} })))).rejects.toThrow(/not a snapshot export/);
    await expect(readSnapshotFile(file(JSON.stringify({ format: "gha-emergency-snapshot/1", manifest: "x", contents: {} })))).rejects.toThrow(/not a snapshot export/);
  });
});
