import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32 } from "./crc32";
import { LogStore } from "./store";

const enc = (s: string) => new TextEncoder().encode(s);

function storeFrom(text: string, chunkSize: number, opts?: { startsMidLog?: boolean }) {
  const bytes = enc(text);
  const store = new LogStore(opts);
  for (let i = 0; i < bytes.length; i += chunkSize) store.append(bytes.subarray(i, i + chunkSize));
  store.finish();
  return store;
}

describe("crc32", () => {
  it("matches zlib for whole and incremental input", () => {
    const data = enc("The quick brown fox jumps over the lazy dog");
    expect(crc32(0, data)).toBe(0x414fa339);
    expect(crc32(crc32(0, data.subarray(0, 10)), data.subarray(10))).toBe(zlibCrc32(data));
  });
});

describe("LogStore", () => {
  const text = "first line\nsecond ✓ line\n\nfourth: checksum mismatch here\nlast without newline";

  it("indexes lines across tiny chunks, including split multi-byte characters", () => {
    for (const size of [1, 2, 3, 7, 1000]) {
      const store = storeFrom(text, size);
      expect(store.lineCount).toBe(5);
      expect(store.rows(0, 10)).toEqual(text.split("\n"));
      expect(store.stats()).toMatchObject({ bytes: enc(text).length, newlines: 4, crc32: zlibCrc32(enc(text)) });
    }
  });

  it("does not count an empty line after a trailing newline", () => {
    expect(storeFrom("a\nb\n", 1).lineCount).toBe(2);
    expect(storeFrom("", 1).lineCount).toBe(0);
  });

  it("finds matches that span chunk boundaries, once per line", () => {
    const store = storeFrom(text, 3);
    expect(store.search("checksum mismatch", 10)).toEqual({ lines: [3], capped: false });
    expect(store.search("line", 10)).toEqual({ lines: [0, 1, 4], capped: false });
    expect(store.search("line", 1)).toEqual({ lines: [0], capped: true });
    expect(store.search("absent", 10).lines).toEqual([]);
  });

  it("drops the partial first line of a mid-log tail", () => {
    const store = storeFrom("tial line\nwhole one\nwhole two\n", 4, { startsMidLog: true });
    expect(store.rows(0, 5)).toEqual(["whole one", "whole two"]);
  });

  it("strips ANSI escape sequences from display rows only", () => {
    const store = storeFrom("\u001b[36;1mcoloured\u001b[0m\n", 5);
    expect(store.rows(0, 1)).toEqual(["coloured"]);
    expect(store.line(0)).toContain("\u001b[36;1m");
  });
});
