import { describe, expect, it } from "vitest";
import { parseQuery } from "./Home";

describe("repository search text", () => {
  it("splits an optional owner from the name; a full owner/repo is exact", () => {
    expect(parseQuery("testapp")).toEqual({ term: "testapp" });
    expect(parseQuery("  acme/  ")).toEqual({ owner: "acme", term: "" });
    expect(parseQuery("acme/test")).toEqual({ owner: "acme", term: "test", exact: { owner: "acme", repo: "test" } });
    expect(parseQuery("https://github.com/acme/app")).toMatchObject({ owner: "acme", term: "app", exact: { owner: "acme", repo: "app" } });
    expect(parseQuery("acme/has space")).toEqual({ owner: "acme", term: "has space" });
    expect(parseQuery("/x")).toEqual({ term: "x" });
  });
});
