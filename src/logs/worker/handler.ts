// Worker message handling, separated from the worker entry so tests can run it in-process.
import { TAIL_PREVIEW_LINES } from "../../config";
import { diffAgainst, findLines, fingerprints } from "../../domain/logs/queries";
import { LogView } from "../../domain/logs/view";
import type { FromWorker, ToWorker } from "./protocol";
import { LogStore } from "./store";

export function createLogWorkerHandler(post: (message: FromWorker) => void, fail: (error: Error) => void) {
  let full = new LogStore();
  let tail: LogStore | null = null;
  let tailBytes: Uint8Array | null = null;
  let view = new LogView();

  return (message: ToWorker): void => {
    // Fixture-mode fault injection (A9 tests). Compiled out of production builds entirely.
    if (__FIXTURE_MODE__ && message.type === "inject-failure") {
      fail(new Error("Injected worker failure (fixture mode fault)"));
      return;
    }
    switch (message.type) {
      case "tail": {
        tailBytes = new Uint8Array(message.buf);
        tail = new LogStore({ startsMidLog: message.startsMidLog });
        tail.append(tailBytes);
        tail.finish();
        const count = tail.lineCount;
        const from = Math.max(0, count - TAIL_PREVIEW_LINES);
        post({ type: "reply", id: message.id, value: { lines: tail.rows(from, count - from), lineCount: count } });
        return;
      }
      case "bytes":
        full.append(new Uint8Array(message.buf));
        post({ type: "ack", n: message.buf.byteLength });
        return;
      case "reset":
        full = new LogStore();
        view = new LogView();
        post({ type: "reply", id: message.id, value: null });
        return;
      case "finish":
        if (message.appendTail && tailBytes) full.append(tailBytes);
        full.finish();
        tailBytes = null;
        post({ type: "reply", id: message.id, value: full.stats() });
        return;
      case "stats":
        post({ type: "reply", id: message.id, value: full.stats() });
        return;
      case "rows": {
        const doc = message.doc === "tail" ? tail : full;
        post({ type: "reply", id: message.id, value: { from: message.from, lines: doc ? doc.rows(message.from, message.count) : [] } });
        return;
      }
      case "search":
        post({ type: "reply", id: message.id, value: full.search(message.query, message.cap) });
        return;
      case "markers":
        post({ type: "reply", id: message.id, value: full.markers() });
        return;
      case "view":
        full.classify();
        post({ type: "reply", id: message.id, value: view.build(full, message.spec) });
        return;
      case "find": {
        const doc = message.doc === "tail" ? tail : full;
        if (!doc) {
          post({ type: "reply", id: message.id, value: { matches: [], capped: false, lines: 0 } });
          return;
        }
        doc.classify();
        post({ type: "reply", id: message.id, value: findLines(doc, message.search, message.kinds, message.cap) });
        return;
      }
      case "fingerprint":
        full.classify();
        post({ type: "reply", id: message.id, value: fingerprints(full, message.essential, message.range) });
        return;
      case "diff":
        full.classify();
        post({ type: "reply", id: message.id, value: diffAgainst(message.other, full, message.essential, message.range, message.maxEdits) });
        return;
      case "view-rows": {
        const current = message.version === view.currentVersion;
        post({ type: "reply", id: message.id, value: { version: message.version, from: message.from, rows: current ? view.rowsAt(message.from, message.count) : [] } });
        return;
      }
    }
  };
}
