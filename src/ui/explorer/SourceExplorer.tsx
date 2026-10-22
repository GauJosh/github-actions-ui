// Workflow source explorer: the workflow files this run used, at the revisions it used, and their reusable-workflow
// calls. Shows what each file DECLARES; links a declaration to the run's job only through the execution graph's
// match. Model: src/domain/insights/source.ts.
import { useState } from "react";
import { REVISION_TEXT } from "../../domain/graph/hierarchy";
import { flattenSource, githubBlobUrl, type SourceJob, type SourceNode } from "../../domain/insights/source";
import { shortSha } from "../format";
import { StatusIcon } from "../status";

type Props = { root: SourceNode; onShowNode(nodeKey: string): void };

const pathId = (n: SourceNode) => n.path.join("/");

function Tree({ node, selected, onSelect }: { node: SourceNode; selected: string; onSelect(id: string): void }) {
  const calls = node.jobs.filter((j) => j.call);
  return (
    <li>
      <button type="button" className={`src-file${pathId(node) === selected ? " selected" : ""}${node.unavailable ? " unavailable" : ""}`} onClick={() => onSelect(pathId(node))} aria-current={pathId(node) === selected} data-testid="source-file" data-path={pathId(node)}>
        {node.labels.length ? node.labels.at(-1) : "Run workflow"}
        <span className="muted"> {node.file ? node.file.path.split("/").at(-1) : "(not read)"}</span>
      </button>
      {calls.length > 0 && (
        <ul>
          {calls.map((j) => (
            <Tree key={j.id} node={j.call!} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

function RunLink({ job, onShowNode }: { job: SourceJob; onShowNode(nodeKey: string): void }) {
  const run = job.run;
  if (!run) return <span className="muted">its jobs are listed in the called workflow</span>;
  if ("nodeKey" in run)
    return (
      <button type="button" className="linklike" onClick={() => onShowNode(run.nodeKey)} data-testid="source-run-link">
        <StatusIcon status={run.status} /> {run.status === "skipped" ? "skipped in this run" : run.status === "not_run" ? "did not run" : `ran: ${run.jobs} job${run.jobs === 1 ? "" : "s"}`} · show
      </button>
    );
  if ("declaredOnly" in run) return <span className="muted">declared; no job with this name in this run</span>;
  return <span className="muted" title={run.unknown}>not matched to this run</span>;
}

export function SourceExplorer({ root, onShowNode }: Props) {
  const [selected, setSelected] = useState("");
  const all = flattenSource(root);
  const node = all.find((n) => pathId(n) === selected) ?? root;
  return (
    <div className="source-explorer" data-testid="source-explorer">
      <p className="note">
        What the workflow files declare, at the revisions this run used. “Ran” links come from matching this run's jobs to these declarations; a declaration
        alone does not mean a job ran. Inputs that reference secrets or look like credentials are not shown.
      </p>
      <div className="src-layout">
        <nav aria-label="Workflow files" className="src-tree">
          <ul>
            <Tree node={root} selected={pathId(node)} onSelect={setSelected} />
          </ul>
        </nav>
        <section className="src-detail" aria-label="Workflow file" data-testid="source-detail">
          <h4>{node.labels.length ? node.labels.join(" › ") : "The run's workflow"}</h4>
          {node.file ? (
            <p data-testid="source-file-ref">
              <code>
                {node.file.repo}/{node.file.path}
              </code>{" "}
              at <span className="mono">{shortSha(node.file.revision)}</span> ({REVISION_TEXT[node.file.source]}) ·{" "}
              <a href={githubBlobUrl(node.file)} target="_blank" rel="noreferrer noopener">
                Open on GitHub
              </a>
            </p>
          ) : null}
          {node.unavailable && (
            <p className="state state-error" data-testid="source-unavailable">
              {node.unavailable}
            </p>
          )}
          {node.problems.length > 0 && <p className="note">Problems in the file: {node.problems.join("; ")}.</p>}
          {node.jobs.length > 0 && (
            <table className="src-jobs" data-testid="source-jobs">
              <thead>
                <tr>
                  <th>Job (declared)</th>
                  <th>Needs</th>
                  <th>Declared settings</th>
                  <th>In this run</th>
                </tr>
              </thead>
              <tbody>
                {node.jobs.map((j) => (
                  <tr key={j.id} data-job={j.id}>
                    <td>
                      <code>{j.id}</code>
                      {j.name && j.name !== j.id && <div className="muted">{j.name}</div>}
                    </td>
                    <td>{j.needs.length ? j.needs.map((n) => <code key={n}>{n} </code>) : <span className="muted">—</span>}</td>
                    <td className="src-settings">
                      {j.environment && (
                        <div>
                          environment: <code>{j.environment}</code>
                        </div>
                      )}
                      {j.condition && (
                        <div>
                          if: <code>{j.condition}</code>
                        </div>
                      )}
                      {j.matrix && <div>matrix</div>}
                      {j.uses ? (
                        <div>
                          uses: <code>{j.uses}</code>
                          {j.call && (
                            <button type="button" className="linklike" onClick={() => setSelected(pathId(j.call!))}>
                              {" "}
                              open ›
                            </button>
                          )}
                          {j.inputs && j.inputs.length > 0 && (
                            <ul className="src-inputs" data-testid="source-inputs">
                              {j.inputs.map((i) => (
                                <li key={i.name} data-kind={i.kind}>
                                  <code>{i.name}</code>: {i.kind === "redacted" ? <em>redacted</em> : <code>{i.value}</code>}
                                  {i.note && <span className="muted"> ({i.note})</span>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : (
                        <div className="muted">
                          {j.steps} step{j.steps === 1 ? "" : "s"}
                        </div>
                      )}
                    </td>
                    <td>
                      <RunLink job={j} onShowNode={onShowNode} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
