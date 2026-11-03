// Security review M2: the runner's secret masker redacts the exact value and its common Base64 encodings, so a
// workflow can't re-encode a secret to dodge exact-match masking. Masking is best-effort and documented as such.
import { describe, expect, it } from "vitest";
import { Masker } from "../../deploy/emergency/runner/engine.ts";

// A harmless test secret, long enough that its encodings are well over the 8-character floor.
const SECRET = "demo-signing-key-7f3a91c2-not-a-real-credential";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const b64url = (s: string) => b64(s).replace(/\+/g, "-").replace(/\//g, "_");
const unpad = (s: string) => s.replace(/=+$/, "");

describe("Masker", () => {
  it("masks the exact value and leaves other text readable", () => {
    const m = new Masker();
    m.add(SECRET);
    expect(m.apply(`using ${SECRET} now`)).toBe("using *** now");
    expect(m.apply("nothing secret here")).toBe("nothing secret here");
  });

  it("masks standard and URL-safe Base64, with and without padding", () => {
    const m = new Masker();
    m.add(SECRET);
    for (const form of [b64(SECRET), unpad(b64(SECRET)), b64url(SECRET), unpad(b64url(SECRET))]) {
      expect(m.apply(`leak=${form}`)).toBe("leak=***");
    }
  });

  it("handles a secret whose Base64 contains + and / (URL-safe variant differs)", () => {
    // Chosen so its standard Base64 has both '+' and '/'.
    const s = "ÿï¾ÿï¾";
    const m = new Masker();
    m.add(s);
    expect(b64(s)).toMatch(/[+/]/);
    expect(m.apply(`a ${b64(s)} b`)).toBe("a *** b");
    expect(m.apply(`a ${b64url(s)} b`)).toBe("a *** b");
  });

  it("masks each line of a multi-line secret and its encodings", () => {
    const m = new Masker();
    m.add("line-one-secret-value\nline-two-secret-value");
    expect(m.apply("x line-one-secret-value y")).toBe("x *** y");
    expect(m.apply(`enc ${b64("line-two-secret-value")}`)).toBe("enc ***");
  });

  it("does not turn short, common strings into ***", () => {
    const m = new Masker();
    m.add("ab"); // base64 "YWI=" is only 4 chars — below the floor, so not registered
    expect(m.apply("YWI= is common base64")).toBe("YWI= is common base64");
    expect(m.apply("ab")).toBe("***"); // the exact value is still masked
  });

  it("applies to overlapping values longest-first", () => {
    const m = new Masker();
    m.add("secret-prefix");
    m.add("secret-prefix-and-more");
    expect(m.apply("x secret-prefix-and-more y")).toBe("x *** y");
  });
});
