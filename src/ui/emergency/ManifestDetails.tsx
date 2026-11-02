// What a snapshot contains and requires: source commit, execution graph, resolved actions, requirements,
// validation findings and packaged files. Used before upload and for stored snapshots.
import type { Diagnostic } from "../../emergency/model";
import type { Manifest } from "../../emergency/snapshot";

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * `serverDiagnostics`: for a stored snapshot, the executor's findings from the packaged files (security review H1),
 * shown instead of the uploader's claims; the source is then labelled as claimed.
 */
export function ManifestDetails({ manifest, digest, serverDiagnostics }: { manifest: Manifest; digest?: string; serverDiagnostics?: Diagnostic[] }) {
  const shown = serverDiagnostics ?? manifest.diagnostics;
  const errors = shown.filter((d) => d.severity === "error");
  const warnings = shown.filter((d) => d.severity === "warning");
  const notes = shown.filter((d) => d.severity === "info");
  const roots = new Map(manifest.roots.map((r) => [r.id, r]));
  return (
    <div className="manifest" data-testid="manifest">
      <dl className="manifest-facts">
        <dt>{serverDiagnostics ? "Source (claimed by the uploader)" : "Source"}</dt>
        <dd>
          <span className="mono">{manifest.source.repository}</span> at <span className="mono">{manifest.source.ref}</span>
        </dd>
        <dt>Commit</dt>
        <dd className="mono" data-testid="manifest-sha">
          {manifest.source.sha}
        </dd>
        {digest && (
          <>
            <dt>Snapshot digest</dt>
            <dd className="mono" data-testid="manifest-digest">
              sha256:{digest}
            </dd>
          </>
        )}
        <dt>Packaged</dt>
        <dd>
          {manifest.totals.files} files, {kb(manifest.totals.bytes)}, each pinned by sha256
        </dd>
        <dt>Expires</dt>
        <dd>{manifest.expiresAt}</dd>
      </dl>

      <h4>{serverDiagnostics ? "Validation (by the executor, from the packaged files)" : "Validation"}</h4>
      {errors.length === 0 ? (
        <p className="tag tag-ok" data-testid="validation-ok">
          No blocking problems
        </p>
      ) : (
        <ul className="diag diag-error" data-testid="validation-errors">
          {errors.map((d, i) => (
            <li key={i}>
              <strong>{d.message}</strong> {d.where && <span className="muted">({d.where})</span>}
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <details open>
          <summary>{warnings.length} differences from GitHub Actions</summary>
          <ul className="diag diag-warning">
            {warnings.map((d, i) => (
              <li key={i}>
                {d.message} {d.where && <span className="muted">({d.where})</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {notes.length > 0 && (
        <details>
          <summary>{notes.length} notes</summary>
          <ul className="diag">
            {notes.map((d, i) => (
              <li key={i}>
                {d.message} {d.where && <span className="muted">({d.where})</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <h4>Execution graph</h4>
      {manifest.workflows.map((w) => (
        <div key={w.key} className="graph-workflow" data-testid="graph-workflow">
          <p>
            <code>{w.key}</code> {w.name && <span className="muted">— {w.name}</span>}
            {w.root !== "workspace" && <span className="muted"> (from {roots.get(w.root)?.repository})</span>}
          </p>
          <ol className="graph-jobs">
            {w.jobs.map((j) => (
              <li key={j.id}>
                <strong>{j.id}</strong>
                {j.needs.length > 0 && <span className="muted"> needs {j.needs.join(", ")}</span>}
                {j.kind === "call" ? (
                  <span>
                    {" "}
                    → calls <code>{j.calls}</code>
                  </span>
                ) : (
                  <ol className="graph-steps">
                    {j.steps.map((s) => (
                      <li key={s.index}>
                        <span className={`kind kind-${s.kind}`}>{s.kind === "run" ? s.shell ?? "bash" : s.kind}</span> {s.label}
                        {s.action && s.kind !== "checkout" && <code className="muted"> {s.action}</code>}
                        {s.scripts.length > 0 && <span className="muted"> · scripts: {s.scripts.join(", ")}</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ol>
        </div>
      ))}

      <h4>Actions</h4>
      <table className="emergency-table" data-testid="manifest-actions">
        <thead>
          <tr>
            <th>uses</th>
            <th>Type</th>
            <th>Packaged from</th>
          </tr>
        </thead>
        <tbody>
          {manifest.actions.map((a) => (
            <tr key={a.key}>
              <td className="mono">{a.key}</td>
              <td>{a.substitutedBy ? "replaced by the packaged workspace" : `${a.using}${a.runtime && a.using !== "composite" ? ` (${a.runtime})` : ""}`}</td>
              <td className="mono">{a.substitutedBy ? "—" : a.root === "workspace" ? `workspace/${a.dir}` : `${roots.get(a.root)?.repository}@${roots.get(a.root)?.sha.slice(0, 12)}/${a.dir}`}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Requirements at execution time</h4>
      <ul className="requirements" data-testid="requirements">
        <li>
          <strong>Secrets</strong> (names only; values come from a Kubernetes Secret when the snapshot runs):{" "}
          {manifest.requirements.secrets.length ? manifest.requirements.secrets.map((s) => <code key={s.name}>{s.name} </code>) : "none"}
        </li>
        <li>
          <strong>Variables</strong>: {manifest.requirements.variables.length ? manifest.requirements.variables.map((s) => <code key={s.name}>{s.name} </code>) : "none"}
        </li>
        {Object.entries(manifest.requirements.inputs).map(([wf, inputs]) => (
          <li key={wf}>
            <strong>Inputs of {wf}</strong>: {Object.keys(inputs).length ? Object.keys(inputs).map((k) => <code key={k}>{k} </code>) : "none"}
          </li>
        ))}
        <li>
          <strong>Runtimes</strong>: {manifest.requirements.runtimes.join(", ") || "none"} (the runner image has Node.js 22, bash, sh and Python 3 with its standard library)
        </li>
        <li>
          <strong>External services</strong>:{" "}
          {manifest.requirements.externalServices.length ? (
            <span className="warn-text">{manifest.requirements.externalServices.map((s) => s.name).join("; ")} — unreachable in isolated runs</span>
          ) : (
            "none detected"
          )}
        </li>
      </ul>

      <details>
        <summary>{manifest.files.length} packaged files</summary>
        <ul className="file-list mono">
          {manifest.files.map((f) => (
            <li key={`${f.root}:${f.path}`}>
              {f.root === "workspace" ? "" : `${roots.get(f.root)?.repository}: `}
              {f.path} <span className="muted">{kb(f.size)} · {f.sha256.slice(0, 12)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
