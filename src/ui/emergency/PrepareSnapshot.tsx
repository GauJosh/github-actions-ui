// Snapshot preparation: choose a repository, ref and workflows; resolve the complete dependency graph at the
// commit; review what will be packaged and what can't run; upload. Reads GitHub only through the app's read-only
// client (GET, the existing token); the GitHub token never leaves the browser.
import { useState } from "react";
import type { Environment } from "../../app/environment";
import { parseRepo } from "../../domain/run-url";
import { executor } from "../../emergency/executor-client";
import { createGitHubReader } from "../../emergency/github-reader";
import { prepareSnapshot, type SourceReader } from "../../emergency/prepare";
import { hasErrors, toBase64, type Manifest, type Visibility } from "../../emergency/snapshot";
import { GitHubError } from "../../github/client";
import { failureText } from "../copy";
import { emergencyHref, errorText } from "./EmergencyView";
import { ManifestDetails } from "./ManifestDetails";

type Prepared = { manifest: Manifest; contents: Map<string, Uint8Array> };

export function PrepareSnapshot({ env, githubConnected }: { env: Environment; githubConnected: boolean }) {
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("main");
  const [found, setFound] = useState<{ sha: string; workflows: string[] } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [days, setDays] = useState(30);
  const [include, setInclude] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [stored, setStored] = useState<{ id: string; version: number; created: boolean } | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("shared");
  const [reader] = useState<SourceReader>(() => createGitHubReader(env.client));

  if (env.mode === "live" && !githubConnected) {
    return (
      <p className="state" data-testid="prepare-needs-github">
        Preparing a snapshot reads the repository from GitHub, so it needs GitHub to be available and a GitHub token. <a href="#/">Connect to GitHub</a>, then come back. Running
        snapshots that are already prepared doesn't.
      </p>
    );
  }

  const fail = (e: unknown) => setError(e instanceof GitHubError ? failureText(e.failure) : errorText(e));
  const repoRef = parseRepo(repo);

  async function loadWorkflows() {
    if (!repoRef) return;
    setBusy("Reading workflows…");
    setError(null);
    setFound(null);
    setPrepared(null);
    setStored(null);
    try {
      const full = `${repoRef.owner}/${repoRef.repo}`;
      const sha = await reader.resolveCommit(full, ref.trim());
      const files = await reader.listFiles(full, sha);
      const workflows = files.map((f) => f.path).filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
      setFound({ sha, workflows });
      setSelected(workflows.slice(0, 1));
      if (!name) setName(`${repoRef.repo} ${ref.trim()}`.replace(/[^A-Za-z0-9 ._-]/g, "-").slice(0, 63));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  async function resolve() {
    if (!repoRef || !found) return;
    setBusy("Resolving dependencies…");
    setError(null);
    setPrepared(null);
    setStored(null);
    try {
      const result = await prepareSnapshot(reader, {
        repository: `${repoRef.owner}/${repoRef.repo}`,
        ref: ref.trim(),
        sha: found.sha,
        workflows: selected,
        name,
        expiresInDays: days,
        include: include
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        onProgress: (m) => setBusy(m),
      });
      setPrepared(result);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  async function upload() {
    if (!prepared) return;
    setBusy("Uploading snapshot…");
    setError(null);
    try {
      const contents = Object.fromEntries([...prepared.contents].map(([k, v]) => [k, toBase64(v)]));
      const r = await executor.uploadSnapshot({ manifest: prepared.manifest, contents }, visibility);
      setStored({ id: r.snapshot.id, version: r.snapshot.version, created: r.created });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="emergency-prepare">
      <p>
        <a href="#/emergency">← Emergency execution</a>
      </p>
      <section className="panel">
        <h3>1. Repository and commit</h3>
        <div className="form-row">
          <label>
            Repository
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" spellCheck={false} data-testid="prepare-repo" />
          </label>
          <label>
            Branch, tag or commit SHA
            <input value={ref} onChange={(e) => setRef(e.target.value)} spellCheck={false} data-testid="prepare-ref" />
          </label>
          <button type="button" onClick={() => void loadWorkflows()} disabled={!repoRef || !ref.trim() || busy !== null} data-testid="load-workflows">
            Find workflows
          </button>
        </div>
        {repo && !repoRef && <p className="muted">Enter the repository as owner/repo.</p>}
        {found && (
          <p data-testid="resolved-commit">
            {ref} is commit <code>{found.sha}</code>. Everything in the snapshot is read at this commit.
          </p>
        )}
      </section>

      {found && (
        <section className="panel">
          <h3>2. Workflows and supporting files</h3>
          {found.workflows.length === 0 ? (
            <p className="muted">No workflows in .github/workflows at this commit.</p>
          ) : (
            <fieldset className="workflow-choice">
              <legend>Workflows to prepare (reusable workflows and actions they use are added automatically)</legend>
              {found.workflows.map((w) => (
                <label key={w} className="check">
                  <input type="checkbox" checked={selected.includes(w)} onChange={(e) => setSelected(e.target.checked ? [...selected, w] : selected.filter((x) => x !== w))} />
                  <code>{w}</code>
                </label>
              ))}
            </fieldset>
          )}
          <div className="form-row">
            <label>
              Snapshot name
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={63} data-testid="prepare-name" />
            </label>
            <label>
              Expires after (days)
              <input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} />
            </label>
            <label className="wide">
              Supporting files (path prefixes, comma-separated; empty packages the whole repository)
              <input value={include} onChange={(e) => setInclude(e.target.value)} placeholder="e.g. scripts, src" spellCheck={false} />
            </label>
          </div>
          <button type="button" onClick={() => void resolve()} disabled={!selected.length || !name.trim() || busy !== null} data-testid="resolve">
            Resolve dependencies and validate
          </button>
        </section>
      )}

      {busy && (
        <p className="state" aria-live="polite">
          {busy}
        </p>
      )}
      {error && (
        <p className="state state-error" role="alert" data-testid="prepare-error">
          {error}
        </p>
      )}

      {prepared && (
        <section className="panel" data-testid="prepared">
          <h3>3. Review</h3>
          <ManifestDetails manifest={prepared.manifest} />
          <div className="emergency-actions">
            {hasErrors(prepared.manifest.diagnostics) ? (
              <p className="state state-error" data-testid="not-executable">
                This pipeline has validation errors (above), so it can't run in an emergency. Change the workflow, or prepare a narrower set of workflows.
              </p>
            ) : stored ? (
              <p className="state" data-testid="stored">
                {stored.created ? "Stored" : "Already stored (identical content)"} as version {stored.version}.{" "}
                <a href={emergencyHref({ page: "snapshot", id: stored.id })}>Open the snapshot</a>
              </p>
            ) : (
              <>
                <label className="visibility">
                  Visibility{" "}
                  <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)} data-testid="snapshot-visibility">
                    <option value="shared">Shared: every viewer sees it, any operator can run it</option>
                    <option value="restricted">Restricted: only you, approvers and administrators see it; only you run it</option>
                  </select>
                </label>{" "}
                <button type="button" className="primary" onClick={() => void upload()} disabled={busy !== null} data-testid="create-snapshot">
                  Create emergency snapshot
                </button>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
