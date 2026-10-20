import { describe, expect, it } from "vitest";
import { patProvider } from "./pat-provider";
import { hostOf, redact } from "./redact";

// Token-shaped strings are assembled at runtime so no credential-like literal exists in the repository.
const fakeClassic = ["ghp", "_", "A".repeat(36)].join("");
const fakeFineGrained = ["github", "_pat_", "B".repeat(30)].join("");

describe("redact", () => {
  it("removes token-shaped strings and bearer values", () => {
    const out = redact(`token ${fakeClassic} and ${fakeFineGrained}; Authorization: Bearer abcdefghijkl`);
    expect(out).not.toContain(fakeClassic);
    expect(out).not.toContain(fakeFineGrained);
    expect(out).not.toContain("abcdefghijkl");
  });

  it("strips query strings (signatures) from URLs, keeping only the location", () => {
    const out = redact("failed: https://productionresultssa1.blob.core.windows.net/a/b.txt?sv=x&sig=SECRET123 then stop");
    expect(out).toBe("failed: https://productionresultssa1.blob.core.windows.net/a/b.txt?[redacted] then stop");
  });

  it("hostOf returns only the host", () => {
    expect(hostOf("https://productionresultssa1.blob.core.windows.net/x?sig=SECRET")).toBe("productionresultssa1.blob.core.windows.net");
    expect(hostOf("not a url")).toBe("unknown");
  });
});

describe("patProvider", () => {
  it("holds the token only in memory and clears it", () => {
    const headers = new Headers();
    patProvider.connect("  test-token-not-real  ");
    patProvider.authorize(headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token-not-real");
    expect(JSON.stringify(patProvider)).not.toContain("test-token-not-real");
    patProvider.clear();
    const after = new Headers();
    patProvider.authorize(after);
    expect(after.has("Authorization")).toBe(false);
    expect(patProvider.describe().connected).toBe(false);
  });
});
