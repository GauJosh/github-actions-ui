// Worker-owned log text: an array of decoded chunk strings that is never joined, a line-start index,
// and running byte, newline and CRC32 counters. Line numbers here are 0-based.
import { LineClassifier, evidenceRank } from "../../domain/logs/classify";
import type { ViewSource } from "../../domain/logs/view";
import { createMarkerScanner, type EvidenceLine, type LogMarkers } from "../../domain/steps/step-map";
import { crc32 } from "./crc32";

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[A-Za-z]", "g");

const MAX_EVIDENCE = 20_000;

export type StoreStats = { bytes: number; lines: number; newlines: number; crc32: number };

export class LogStore implements ViewSource {
  private decoder = new TextDecoder("utf-8");
  private chunks: string[] = [];
  private chunkStarts: number[] = [];
  private chars = 0;
  private lineStarts = new Uint32Array(4096);
  private lineStartCount = 1;
  private bytes = 0;
  private newlines = 0;
  private crc = 0;
  private skipToNewline: boolean;
  private finished = false;
  /** Line classification for display modes, extended lazily over complete lines (docs/ARCHITECTURE.md §8.1). */
  readonly classified = new LineClassifier();

  /** `startsMidLog`: the bytes begin at an arbitrary offset, so the first (partial) line is dropped. */
  constructor(options: { startsMidLog?: boolean } = {}) {
    this.skipToNewline = options.startsMidLog ?? false;
  }

  append(data: Uint8Array): void {
    this.bytes += data.byteLength;
    this.crc = crc32(this.crc, data);
    this.push(this.decoder.decode(data, { stream: true }));
  }

  finish(): void {
    this.push(this.decoder.decode());
    this.finished = true;
  }

  private push(text: string): void {
    if (this.skipToNewline) {
      const nl = text.indexOf("\n");
      if (nl === -1) return;
      text = text.slice(nl + 1);
      this.skipToNewline = false;
    }
    if (!text) return;
    this.chunkStarts.push(this.chars);
    this.chunks.push(text);
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      this.newlines++;
      this.addLineStart(this.chars + i + 1);
    }
    this.chars += text.length;
  }

  private addLineStart(offset: number): void {
    if (this.lineStartCount === this.lineStarts.length) {
      const grown = new Uint32Array(this.lineStarts.length * 2);
      grown.set(this.lineStarts);
      this.lineStarts = grown;
    }
    this.lineStarts[this.lineStartCount++] = offset;
  }

  /** Lines available so far. A trailing newline does not start a further line. */
  get lineCount(): number {
    if (this.chars === 0) return 0;
    return this.lineStarts[this.lineStartCount - 1] === this.chars ? this.lineStartCount - 1 : this.lineStartCount;
  }

  /** Lines whose text is final: all of them once finished, otherwise those ended by a newline. */
  get completeLines(): number {
    const count = this.lineCount;
    if (this.finished || count === 0) return count;
    return this.lineStarts[this.lineStartCount - 1] === this.chars ? count : count - 1;
  }

  /** Classifies the complete lines not classified yet. */
  classify(): void {
    const upTo = this.completeLines;
    for (let n = this.classified.count; n < upTo; n++) this.classified.push(this.line(n));
  }

  /** Display text of one line, with ANSI escape sequences removed. */
  text(n: number): string {
    return this.line(n).replace(ANSI, "");
  }

  stats(): StoreStats {
    return { bytes: this.bytes, lines: this.lineCount, newlines: this.newlines, crc32: this.crc };
  }

  line(n: number): string {
    const start = this.lineStarts[n]!;
    const end = n + 1 < this.lineStartCount ? this.lineStarts[n + 1]! - 1 : this.chars;
    return this.slice(start, end);
  }

  /** Display rows with ANSI escape sequences removed (colour rendering is milestone M2). */
  rows(from: number, count: number): string[] {
    const end = Math.min(this.lineCount, from + count);
    const out: string[] = [];
    for (let n = Math.max(0, from); n < end; n++) out.push(this.text(n));
    return out;
  }

  private chunkIndex(offset: number): number {
    let lo = 0;
    let hi = this.chunkStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.chunkStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private slice(start: number, end: number): string {
    if (end <= start) return "";
    let k = this.chunkIndex(start);
    let out = "";
    let pos = start;
    while (pos < end && k < this.chunks.length) {
      const chunk = this.chunks[k]!;
      const base = this.chunkStarts[k]!;
      out += chunk.slice(pos - base, Math.min(end - base, chunk.length));
      pos = base + chunk.length;
      k++;
    }
    return out;
  }

  private lineOf(offset: number): number {
    let lo = 0;
    let hi = this.lineStartCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * One pass over the lines received so far, collecting step markers and `##[error]` lines (no copy of the log is
   * kept), plus the classified lines of failure evidence.
   */
  markers(): LogMarkers {
    const scanner = createMarkerScanner();
    const count = this.lineCount;
    for (let n = 0; n < count; n++) scanner.push(this.line(n));
    this.classify();
    const c = this.classified;
    const evidence: EvidenceLine[] = [];
    for (let n = 0; n < c.count && evidence.length < MAX_EVIDENCE; n++) {
      const rank = evidenceRank(c.kinds[n]!, c.reasons[n]!);
      if (rank >= 0) evidence.push({ line: n, rank });
    }
    return { ...scanner.result(count), evidence };
  }

  /** Case-sensitive substring search across chunk boundaries. Returns 0-based line numbers, one per line. */
  search(query: string, cap: number): { lines: number[]; capped: boolean } {
    const lines: number[] = [];
    if (!query) return { lines, capped: false };
    let carry = "";
    for (let k = 0; k < this.chunks.length; k++) {
      const text = carry + this.chunks[k]!;
      const base = this.chunkStarts[k]! - carry.length;
      for (let i = text.indexOf(query); i !== -1; i = text.indexOf(query, i + 1)) {
        const line = this.lineOf(base + i);
        if (lines[lines.length - 1] !== line) {
          if (lines.length === cap) return { lines, capped: true };
          lines.push(line);
        }
      }
      carry = query.length > 1 ? text.slice(-(query.length - 1)) : "";
    }
    return { lines, capped: false };
  }
}
