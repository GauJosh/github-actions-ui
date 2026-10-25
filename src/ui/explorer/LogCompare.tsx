// Log comparison: two job logs (one job in two attempts or runs), or one step of each when both logs map their
// steps reliably. Each log stays in its own worker: the baseline's worker returns line fingerprints only, and this
// run's worker computes the diff. Only the lines shown are read back as text, and the number shown is capped.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Environment } from "../../app/environment";
import { countDifferences, hunks, type DiffOp } from "../../domain/compare/diff";
import { LINE_KINDS, type LineKind } from "../../domain/logs/classify";
import type { Fingerprints } from "../../domain/logs/queries";
import { mapSteps, type StepMapping } from "../../domain/steps/step-map";
import type { Job, JobRef } from "../../domain/types";
import type { LogLoader, LogSnapshot } from "../../logs/download/loader";
import { LogPool } from "../../logs/pool";
import { logStatusText } from "../copy";

type SideSpec = { ref: JobRef; job: Job; attempt: number; href(line: number): string };
type Props = { env: Environment; label: string; base: SideSpec; head: SideSpec; uncertain: boolean; onClose(): void };

const MAX_SHOWN = 600;
const MAX_EDITS = 3000;
const ERROR_KINDS = new Set(["error", "error-signature", "test-failed", "error-text", "stack"].map((k) => LINE_KINDS.indexOf(k as LineKind)));

type Row = { kind: DiffOp["kind"] | "hunk"; text: string; a?: number; b?: number; error?: boolean };
type Outcome =
  | { kind: "diff"; rows: Row[]; added: number; removed: number; addedErrors: number; removedErrors: number; truncated: boolean; compared: [number, number] }
  | { kind: "coarse"; rows: Row[]; added: number; removed: number; compared: [number, number] }
  | { kind: "same"; compared: [number, number] }
  | { kind: "unavailable"; why: string };

function useSnapshot(loader: LogLoader | undefined): LogSnapshot | undefined {
  return useSyncExternalStore(
    (on) => loader?.subscribe(on) ?? (() => {}),
    () => loader?.snapshot,
  );
}

export function LogCompare({ env, label, base, head, uncertain, onClose }: Props) {
  // One pool per pair of jobs: both workers are terminated when the panel closes or the pair changes.
  const pairKey = [base.ref.owner, base.ref.repo, base.ref.runId, base.ref.jobId, head.ref.runId, head.ref.jobId].join("/");
  const pool = useMemo(() => new LogPool(env.createLoader, 2, 2), [env, pairKey]); // eslint-disable-line react-hooks/exhaustive-deps -- a new pool per pair
  useEffect(() => {
    pool.open(base.ref);
    pool.open(head.ref);
    return () => pool.dispose();
  }, [pool]); // eslint-disable-line react-hooks/exhaustive-deps -- the refs are part of the pool's key
  const version = useSyncExternalStore(pool.subscribe, pool.version);
  const loaders = useMemo(() => ({ base: pool.get(base.ref.jobId), head: pool.get(head.ref.jobId) }), [pool, version, base.ref.jobId, head.ref.jobId]); // eslint-disable-line react-hooks/exhaustive-deps -- `version`: re-read when the pool changes
  const bSnap = useSnapshot(loaders.base);
  const hSnap = useSnapshot(loaders.head);
  const [essential, setEssential] = useState(true);
  const [stepName, setStepName] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [mappings, setMappings] = useState<{ base?: StepMapping; head?: StepMapping }>({});
  const [outcome, setOutcome] = useState<{ key: string; value: Outcome } | null>(null);

  const ready = bSnap?.status === "complete" && hSnap?.status === "complete";
  // Step boundaries of both logs, once both are complete.
  useEffect(() => {
    if (!ready || !loaders.base || !loaders.head) return;
    let live = true;
    void Promise.all([loaders.base.markers(), loaders.head.markers()]).then(([bm, hm]) => {
      if (!live) return;
      setMappings({ base: bm && base.job.steps ? mapSteps(base.job.steps, bm) : undefined, head: hm && head.job.steps ? mapSteps(head.job.steps, hm) : undefined });
    });
    return () => {
      live = false;
    };
  }, [ready, loaders, base.job.steps, head.job.steps]);

  // Steps that exist once by name on both sides and were located in both logs.
  const steps = useMemo(() => {
    const once = (job: Job) => new Set((job.steps ?? []).map((s) => s.name).filter((n, i, all) => all.indexOf(n) === all.lastIndexOf(n)));
    const b = once(base.job);
    return [...once(head.job)].filter((n) => b.has(n));
  }, [base.job, head.job]);
  const rangeOf = (job: Job, mapping: StepMapping | undefined, name: string): { range?: [number, number]; approximate?: boolean } => {
    const step = job.steps?.find((s) => s.name === name);
    const seg = step && mapping?.segments.find((s) => s.stepNumber === step.number);
    return seg ? { range: [seg.startLine - 1, seg.endLine], approximate: mapping!.mapping !== "exact-checks-passed" } : {};
  };
  const bRange = stepName ? rangeOf(base.job, mappings.base, stepName) : {};
  const hRange = stepName ? rangeOf(head.job, mappings.head, stepName) : {};
  const stepUnavailable = Boolean(stepName) && (!bRange.range || !hRange.range);
  const key = `${essential}|${stepName}|${bRange.range?.join("-")}|${hRange.range?.join("-")}`;

  useEffect(() => {
    if (!ready || !loaders.base || !loaders.head || stepUnavailable) return;
    let live = true;
    void (async () => {
      const value = await compute(loaders.base!, loaders.head!, essential, bRange.range, hRange.range);
      if (live) setOutcome({ key, value });
    })();
    return () => {
      live = false;
    };
  }, [ready, loaders, key, stepUnavailable]); // eslint-disable-line react-hooks/exhaustive-deps -- ranges are part of `key`

  const current = outcome?.key === key ? outcome.value : null;
  const sideStatus = (name: string, snap: LogSnapshot | undefined, loader: LogLoader | undefined) => {
    if (!snap) return null;
    if (snap.status === "complete") return null;
    return (
      <p className={["expired", "unavailable", "failed", "processing-failed"].includes(snap.status) ? "state state-error" : "state"} data-testid="logcmp-side-status">
        {name}: {logStatusText(snap)}
        {snap.status === "tail-only" && loader && (
          <>
            {" "}
            Only complete logs are compared.{" "}
            <button type="button" onClick={() => void loader.loadFull()}>
              Load the full log
            </button>
          </>
        )}
      </p>
    );
  };
  const rows = current && (current.kind === "diff" || current.kind === "coarse") ? (onlyErrors && current.kind === "diff" ? errorHunks(current.rows) : current.rows) : [];

  return (
    <section className="compare-section logcmp" aria-labelledby="logcmp-heading" data-testid="log-compare">
      <header className="compare-section-head">
        <h4 id="logcmp-heading">
          Log comparison: {label} <span className="muted">(baseline attempt {base.attempt} → this run attempt {head.attempt})</span>
        </h4>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      {uncertain && <p className="state state-warn">These jobs were not matched by their workflow job id, so they may not be the same job. Read the differences with that in mind.</p>}
      {sideStatus("Baseline log", bSnap, loaders.base)}
      {sideStatus("This run's log", hSnap, loaders.head)}
      <div className="logcmp-controls">
        <label>
          Compare{" "}
          <select value={stepName} onChange={(e) => setStepName(e.target.value)} data-testid="logcmp-step">
            <option value="">the whole log</option>
            {steps.map((n) => (
              <option key={n} value={n}>
                step: {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={essential} onChange={(e) => setEssential(e.target.checked)} /> Essential output only
        </label>
        <label>
          <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} data-testid="logcmp-only-errors" /> Only changes with errors
        </label>
      </div>
      <p className="note">
        Lines are compared without timestamps, times, ids, commit hashes, durations and temporary paths.
        {essential ? " Runner setup, cleanup and the echo of step scripts are left out." : ""}
        {(bRange.approximate || hRange.approximate) && " The step boundaries in one of the logs are approximate."}
      </p>
      {stepUnavailable && <p className="state">The step &quot;{stepName}&quot; could not be located in both logs, so it cannot be compared on its own.</p>}
      {ready && !current && !stepUnavailable && <p className="state">Comparing…</p>}
      {current?.kind === "unavailable" && <p className="state state-error">{current.why}</p>}
      {current?.kind === "same" && (
        <p className="note" data-testid="logcmp-summary">
          No differences in the {current.compared[0]} and {current.compared[1]} lines compared.
        </p>
      )}
      {current && (current.kind === "diff" || current.kind === "coarse") && (
        <>
          <p data-testid="logcmp-summary">
            {current.added} line{current.added === 1 ? "" : "s"} only in this run, {current.removed} only in the baseline (of {current.compared[1]} and {current.compared[0]} compared).
            {current.kind === "diff" && ` Error lines: ${current.addedErrors} new, ${current.removedErrors} no longer present.`}
          </p>
          {current.kind === "coarse" && <p className="note">The logs differ too much for a line-by-line diff; lines present in only one log are listed instead, in log order.</p>}
          {current.kind === "diff" && current.truncated && <p className="note">Only the first {MAX_SHOWN} lines of differences are shown.</p>}
          <p className="note">An error line that is new in this run is a difference, not necessarily the cause of the failure.</p>
          <pre className="compare-diff" data-testid="logcmp-diff">
            {rows.map((r, i) => (
              <span key={i} className={`dl d-${r.kind}${r.error ? " d-error" : ""}`} data-kind={r.kind}>
                {r.kind === "hunk" ? (
                  r.text
                ) : (
                  <>
                    <a href={r.kind === "remove" || r.b === undefined ? base.href(r.a! + 1) : head.href(r.b + 1)} className="dl-num" title="Open the source log at this line">
                      {r.kind === "remove" ? `B${r.a! + 1}` : r.kind === "add" ? `T${r.b! + 1}` : `T${r.b! + 1}`}
                    </a>
                    {r.kind === "add" ? "+ " : r.kind === "remove" ? "− " : "  "}
                    {r.text}
                  </>
                )}
                {"\n"}
              </span>
            ))}
          </pre>
        </>
      )}
    </section>
  );
}

function errorHunks(rows: Row[]): Row[] {
  const out: Row[] = [];
  let hunk: Row[] = [];
  const flush = () => {
    if (hunk.some((r) => r.error && r.kind !== "equal")) out.push(...hunk);
    hunk = [];
  };
  for (const r of rows) {
    if (r.kind === "hunk") flush();
    hunk.push(r);
  }
  flush();
  return out;
}

/** Reads the text of the given 0-based lines from one log, in contiguous batches. */
async function textOf(loader: LogLoader, lines: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]! - sorted[i]! < 200) j++;
    const from = sorted[i]!;
    const rows = await loader.rows("full", from, sorted[j]! - from + 1);
    for (let k = i; k <= j; k++) out.set(sorted[k]!, rows[sorted[k]! - from] ?? "");
    i = j + 1;
  }
  return out;
}

async function compute(baseLoader: LogLoader, headLoader: LogLoader, essential: boolean, bRange?: [number, number], hRange?: [number, number]): Promise<Outcome> {
  const a: Fingerprints | null = await baseLoader.fingerprints(essential, bRange);
  if (!a) return { kind: "unavailable", why: "The baseline log could not be read for comparison." };
  const result = await headLoader.diffAgainst(a.hashes, essential, hRange, MAX_EDITS);
  if (!result) return { kind: "unavailable", why: "This run's log could not be read for comparison." };
  const b = result.own;
  const compared: [number, number] = [a.hashes.length, b.hashes.length];
  if ("tooLarge" in result.diff) {
    const { onlyA, onlyB } = countDifferences(a.hashes, b.hashes);
    const showA = onlyA.slice(0, MAX_SHOWN / 2);
    const showB = onlyB.slice(0, MAX_SHOWN / 2);
    const [ta, tb] = await Promise.all([textOf(baseLoader, showA.map((i) => a.lines[i]!)), textOf(headLoader, showB.map((i) => b.lines[i]!))]);
    const rows: Row[] = [
      { kind: "hunk", text: `Only in the baseline (${onlyA.length})` },
      ...showA.map((i): Row => ({ kind: "remove", a: a.lines[i]!, text: ta.get(a.lines[i]!) ?? "", error: ERROR_KINDS.has(a.kinds[i]!) })),
      { kind: "hunk", text: `Only in this run (${onlyB.length})` },
      ...showB.map((i): Row => ({ kind: "add", b: b.lines[i]!, text: tb.get(b.lines[i]!) ?? "", error: ERROR_KINDS.has(b.kinds[i]!) })),
    ];
    return { kind: "coarse", rows, added: onlyB.length, removed: onlyA.length, compared };
  }
  const ops = result.diff.ops;
  let added = 0;
  let removed = 0;
  let addedErrors = 0;
  let removedErrors = 0;
  for (const op of ops) {
    for (let i = 0; i < op.length; i++) {
      if (op.kind === "add") {
        added++;
        if (ERROR_KINDS.has(b.kinds[op.b + i]!)) addedErrors++;
      } else if (op.kind === "remove") {
        removed++;
        if (ERROR_KINDS.has(a.kinds[op.a + i]!)) removedErrors++;
      }
    }
  }
  if (added + removed === 0) return { kind: "same", compared };
  // The rows to show (capped), then their text, read from each worker in batches.
  const plan: Row[] = [];
  let truncated = false;
  outer: for (const h of hunks(ops, 3)) {
    plan.push({ kind: "hunk", text: `@@ baseline lines ${a.lines[h.a[0]] !== undefined ? a.lines[h.a[0]]! + 1 : "—"} · this run lines ${b.lines[h.b[0]] !== undefined ? b.lines[h.b[0]]! + 1 : "—"}` });
    for (const op of h.ops)
      for (let i = 0; i < op.length; i++) {
        if (plan.length >= MAX_SHOWN) {
          truncated = true;
          break outer;
        }
        const ai = op.a + i;
        const bi = op.b + i;
        if (op.kind === "add") plan.push({ kind: "add", b: b.lines[op.b + i]!, text: "", error: ERROR_KINDS.has(b.kinds[op.b + i]!) });
        else if (op.kind === "remove") plan.push({ kind: "remove", a: a.lines[ai]!, text: "", error: ERROR_KINDS.has(a.kinds[ai]!) });
        else plan.push({ kind: "equal", a: a.lines[ai]!, b: b.lines[bi]!, text: "" });
      }
  }
  const [ta, tb] = await Promise.all([
    textOf(baseLoader, plan.filter((r) => r.kind === "remove").map((r) => r.a!)),
    textOf(headLoader, plan.filter((r) => r.kind === "add" || r.kind === "equal").map((r) => r.b!)),
  ]);
  for (const r of plan) if (r.kind !== "hunk") r.text = r.kind === "remove" ? (ta.get(r.a!) ?? "") : (tb.get(r.b!) ?? "");
  return { kind: "diff", rows: plan, added, removed, addedErrors, removedErrors, truncated, compared };
}
