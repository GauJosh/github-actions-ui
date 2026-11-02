// One stored snapshot: its manifest, an integrity check, and the form that starts an emergency execution.
import { useEffect, useMemo, useState } from "react";
import type { Environment } from "../../app/environment";
import { executor, type NetworkCheckView, type NetworkMode, type SecretBindingView } from "../../emergency/executor-client";
import { checkProvenance, type Provenance } from "../../emergency/provenance";
import { manifestDigest, type Manifest, type SnapshotRecord } from "../../emergency/snapshot";
import { can, emergencyHref, errorText, useSession } from "./EmergencyView";
import { ManifestDetails } from "./ManifestDetails";

export function SnapshotPage({ id, env, githubConnected }: { id: string; env: Environment; githubConnected: boolean }) {
  const [data, setData] = useState<{
    record: SnapshotRecord;
    manifest: Manifest;
    expired: boolean;
    secretBinding: SecretBindingView | null;
    secretBindingProblem: string | null;
    allowEgress: boolean;
    approvalPolicy?: { requireFor: string[]; separationOfDuties: boolean; ttlMinutes: number };
  } | null>(null);
  const session = useSession();
  const [digestOk, setDigestOk] = useState<boolean | null>(null);
  const [verify, setVerify] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    executor
      .getSnapshot(id)
      .then(async (d) => {
        setData({ ...d, expired: Date.parse(d.record.expiresAt) <= Date.now() });
        // The browser checks for itself that the manifest it shows is the one the ID names.
        setDigestOk((await manifestDigest(d.manifest)) === id);
      })
      .catch((e) => setError(errorText(e)));
  }, [id]);

  if (error) return <p className="state state-error">{error}</p>;
  if (!data) return <p className="state">Loading snapshot…</p>;
  const { record, manifest, expired } = data;
  return (
    <div className="emergency-snapshot">
      <p>
        <a href="#/emergency">← Emergency execution</a>
      </p>
      <section className="panel">
        <div className="panel-head">
          <h3 data-testid="snapshot-title">
            {record.name} <span className="muted">version {record.version}</span>
          </h3>
          <button
            type="button"
            disabled={!can(session, "snapshots.verify")}
            onClick={async () => {
              setVerify("Verifying…");
              try {
                const r = await executor.verifySnapshot(id);
                setVerify(r.ok ? `Verified: all ${manifest.files.length} stored files match their sha256` : `Verification failed: ${r.problems.map((p) => p.message).join("; ")}`);
              } catch (e) {
                setVerify(errorText(e));
              }
            }}
            data-testid="verify-snapshot"
          >
            Verify stored files
          </button>
        </div>
        {verify && (
          <p className="state" data-testid="verify-result">
            {verify}
          </p>
        )}
        {digestOk === false && <p className="state state-error">The manifest does not match this snapshot's digest. Don't run it.</p>}
        <p className="muted" data-testid="snapshot-owner">
          Prepared by {record.preparedBy?.name ?? "— (before sign-in)"}
          {record.visibility === "restricted" ? " · restricted: only its preparer, approvers and administrators see it, and only its preparer runs it" : " · shared"}
        </p>
        <ManifestDetails manifest={manifest} digest={id} serverDiagnostics={record.validation?.diagnostics ?? []} />
        <IntegrityAndProvenance record={record} manifest={manifest} env={env} githubConnected={githubConnected} />
      </section>
      <section className="panel">
        <h3>Run in an emergency</h3>
        {expired ? (
          <p className="state state-error">This snapshot expired on {record.expiresAt}. Prepare a new one.</p>
        ) : !record.executable ? (
          <p className="state state-error" data-testid="server-not-executable">
            The executor's validation of the packaged files found errors or mismatches, so this snapshot can't run.
          </p>
        ) : !can(session, "executions.create") ? (
          <p className="muted" data-testid="cannot-execute">
            Starting executions needs the operator role.
          </p>
        ) : record.visibility === "restricted" && record.preparedBy?.id !== session.user.id ? (
          <p className="muted" data-testid="cannot-execute">
            Only its preparer can run a restricted snapshot.
          </p>
        ) : (
          <ExecuteForm id={id} manifest={manifest} binding={data.secretBinding} bindingProblem={data.secretBindingProblem} allowEgress={data.allowEgress} approvalPolicy={data.approvalPolicy} restricted={record.visibility === "restricted"} />
        )}
      </section>
    </div>
  );
}

function ExecuteForm({
  id,
  manifest,
  binding,
  bindingProblem,
  allowEgress,
  approvalPolicy,
  restricted,
}: {
  id: string;
  manifest: Manifest;
  binding: SecretBindingView | null;
  bindingProblem: string | null;
  allowEgress: boolean;
  approvalPolicy?: { requireFor: string[]; separationOfDuties: boolean; ttlMinutes: number };
  restricted: boolean;
}) {
  const [workflow, setWorkflow] = useState(manifest.entryWorkflows[0]!);
  const specs = useMemo(() => manifest.requirements.inputs[workflow] ?? {}, [manifest, workflow]);
  const [inputs, setInputs] = useState<Record<string, string>>(() => defaults(manifest.requirements.inputs[manifest.entryWorkflows[0]!] ?? {}));
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [network, setNetwork] = useState<NetworkMode>("isolated");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<NetworkCheckView | null>(null);
  const [checking, setChecking] = useState(false);
  const secrets = manifest.requirements.secrets;
  // Security review C1: the Secret comes from an administrator's binding to this snapshot's digest.
  const missingKeys = binding ? secrets.map((s) => s.name).filter((k) => !binding.keys.includes(k)) : [];
  const authorized = secrets.length === 0 || (binding !== null && missingKeys.length === 0);
  useEffect(() => {
    let live = true;
    executor.getNetworkCheck().then(
      (c) => live && setCheck(c),
      () => live && setCheck(null),
    );
    return () => {
      live = false;
    };
  }, []);
  const verdict = network === "isolated" ? check?.state : check?.egress?.state;
  // Security review H2: the executor decides; this only says in advance what its approval policy will ask for.
  const req = approvalPolicy?.requireFor ?? [];
  const needsApproval = [
    req.includes("all") && "every execution",
    req.includes("secrets") && secrets.length > 0 && "it receives a Secret",
    req.includes("egress") && network === "egress" && "egress mode",
    req.includes("restricted") && restricted && "a restricted snapshot",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <form
      className="execute-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const x = await executor.startExecution({ snapshotId: id, workflow, inputs, variables, network });
          window.location.hash = emergencyHref({ page: "execution", id: x.id });
        } catch (err) {
          setError(errorText(err));
          setBusy(false);
        }
      }}
    >
      <p className="muted">
        Runs <strong>{manifest.source.sha.slice(0, 7)}</strong> from the stored snapshot as a Kubernetes Job. Results are not reported to GitHub: reconcile them after GitHub recovers.
      </p>
      <label>
        Workflow
        <select
          value={workflow}
          onChange={(e) => {
            setWorkflow(e.target.value);
            setInputs(defaults(manifest.requirements.inputs[e.target.value] ?? {}));
          }}
        >
          {manifest.entryWorkflows.map((w) => (
            <option key={w}>{w}</option>
          ))}
        </select>
      </label>
      {Object.entries(specs).map(([name, spec]) => (
        <label key={name}>
          Input <code>{name}</code>
          {spec.required && " (required)"}
          {spec.description && <span className="muted"> — {spec.description}</span>}
          <input value={inputs[name] ?? ""} onChange={(e) => setInputs({ ...inputs, [name]: e.target.value })} data-testid={`input-${name}`} />
        </label>
      ))}
      {manifest.requirements.variables.map((v) => (
        <label key={v.name}>
          Variable <code>vars.{v.name}</code> (not secret)
          <input value={variables[v.name] ?? ""} onChange={(e) => setVariables({ ...variables, [v.name]: e.target.value })} required />
        </label>
      ))}
      {secrets.length > 0 && (
        <div className="binding" data-testid="secret-binding">
          <strong>Secrets</strong>
          {bindingProblem ? (
            <p className="state state-error">{bindingProblem}</p>
          ) : !binding ? (
            <p className="state state-error" data-testid="not-authorized">
              Not authorized: no Secret is bound to this snapshot. A cluster administrator must bind a Secret with {secrets.map((s) => s.name).join(", ")} to digest{" "}
              <code>{id}</code> (chart value <code>secretBindings</code>).
            </p>
          ) : missingKeys.length ? (
            <p className="state state-error">The binding {binding.name} does not permit {missingKeys.join(", ")}.</p>
          ) : (
            <p>
              <code>{secrets.map((s) => s.name).join(", ")}</code> from Secret <code>{binding.secret}</code> (binding {binding.name}). Only these keys are mounted; values never pass through
              this page.
            </p>
          )}
        </div>
      )}
      <fieldset>
        <legend>Network</legend>
        <label className="check">
          <input type="radio" checked={network === "isolated"} onChange={() => setNetwork("isolated")} /> Isolated: no network at all, enforced by NetworkPolicy (simulates GitHub being
          unavailable)
        </label>
        {allowEgress && (
          <label className="check warn-text">
            <input type="radio" checked={network === "egress"} onChange={() => setNetwork("egress")} /> Egress — NOT isolated: public internet reachable (including GitHub by IP address);
            cluster, node, API-server and metadata addresses blocked. Does not simulate an outage.
          </label>
        )}
        <p data-testid="network-verdict" className={verdict === "enforced" ? "" : "warn-text"}>
          {check === null
            ? "Network check status unavailable."
            : verdict === "enforced"
              ? `Isolation verified by the network canary at ${check.checkedAt}.`
              : verdict === "checking"
                ? "The network canary is running…"
                : `Not verified (${verdict ?? "not run"}): ${(network === "isolated" ? check.reason : check.egress?.reason) ?? "no result yet"}. Executions in this mode are refused.`}{" "}
          <button
            type="button"
            className="link-button"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              try {
                setCheck(await executor.runNetworkCheck());
              } catch (err) {
                setError(errorText(err));
              } finally {
                setChecking(false);
              }
            }}
            data-testid="run-network-check"
          >
            {checking ? "Checking…" : "Check again"}
          </button>
        </p>
      </fieldset>
      {needsApproval && (
        <p className="muted" data-testid="needs-approval">
          This execution needs an approver's decision before it starts ({needsApproval}). It waits on its page; the approval covers exactly these inputs and this Secret binding
          {approvalPolicy?.separationOfDuties ? ", and must come from someone other than you or the snapshot's preparer" : ""}.
        </p>
      )}
      <button type="submit" className="primary danger" disabled={busy || !authorized} data-testid="start-execution">
        {busy ? "Starting…" : needsApproval ? "Request emergency execution" : "Start emergency execution"}
      </button>
      {error && (
        <p className="state state-error" role="alert" data-testid="execute-error">
          {error}
        </p>
      )}
    </form>
  );
}

function defaults(specs: Record<string, { default?: unknown }>): Record<string, string> {
  return Object.fromEntries(Object.entries(specs).flatMap(([k, s]) => (s.default === undefined ? [] : [[k, String(s.default)]])));
}

/**
 * Two separate questions (security review H1):
 * - content integrity: verified offline by the executor (Git object IDs recomputed from the packaged files);
 * - provenance: is that content the claimed commit on GitHub? Checked here, live, with this browser's read-only
 *   GitHub access. The result is shown only to whoever checked it and never stored by or sent to the executor.
 */
function IntegrityAndProvenance({ record, manifest, env, githubConnected }: { record: SnapshotRecord; manifest: Manifest; env: Environment; githubConnected: boolean }) {
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = { "tree-verified": "Git tree verified", "blobs-verified": "Git blobs verified (partial root)", unverified: "not verified" } as const;
  return (
    <div className="provenance">
      <h4>Content integrity (checked by the executor, offline)</h4>
      <ul className="requirements" data-testid="integrity">
        {(record.integrity ?? []).map((i) => (
          <li key={i.root}>
            <span className={`tag ${i.status === "unverified" ? "" : "tag-ok"}`}>{label[i.status]}</span> <span className="mono">{i.repository}</span> — {i.detail}
          </li>
        ))}
      </ul>
      <h4>Provenance on GitHub</h4>
      <p className="muted">
        The source repository and commit are the uploader's claim. Checking them asks GitHub, read-only, whether that commit exists and contains exactly this content. The result
        stays in this browser.
      </p>
      <p data-testid="provenance-status">
        {provenance ? (
          <span className={`tag ${provenance.status === "verified" ? "tag-ok" : provenance.status === "failed" ? "tag-bad" : ""}`}>{provenance.status}</span>
        ) : (
          <span className="tag">not checked — unverified</span>
        )}{" "}
        {provenance && <span className="muted">checked {provenance.checkedAt}</span>}{" "}
        <button
          type="button"
          disabled={checking || (env.mode === "live" && !githubConnected)}
          onClick={async () => {
            setChecking(true);
            setError(null);
            try {
              setProvenance(await checkProvenance(env.client, manifest, record.integrity));
            } catch (e) {
              setError(errorText(e));
            } finally {
              setChecking(false);
            }
          }}
          data-testid="check-provenance"
        >
          {checking ? "Checking…" : "Check against GitHub"}
        </button>
        {env.mode === "live" && !githubConnected && <span className="muted"> (connect to GitHub first)</span>}
      </p>
      {error && <p className="state state-error">{error}</p>}
      {provenance && (
        <ul className="requirements" data-testid="provenance-roots">
          {provenance.roots.map((r) => (
            <li key={`${r.repository}@${r.sha}:${r.kind}`}>
              <span className={`tag ${r.status === "verified" ? "tag-ok" : r.status === "failed" ? "tag-bad" : ""}`}>{r.status}</span>{" "}
              <span className="mono">
                {r.repository}@{r.sha.slice(0, 12)}
              </span>{" "}
              — {r.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
