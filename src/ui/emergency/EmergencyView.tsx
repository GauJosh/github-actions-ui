// Emergency execution (docs/EMERGENCY_EXECUTION.md): a separate area from the read-only investigation views.
// - Preparation reads GitHub while it is available (the app's read-only client) and uploads a snapshot.
// - Everything else talks only to this deployment's emergency executor, so it keeps working while GitHub is down:
//   no GitHub token is needed to list snapshots, start an execution or follow it.
// - Security review H2: users sign in with the organization's identity provider (or a break-glass account), and what
//   they can do depends on the roles an administrator gave them. The UI only hides what they can't do; the executor
//   checks every request.
import { createContext, useContext, useEffect, useState } from "react";
import type { Environment } from "../../app/environment";
import { executor, ExecutorError, signInUrl, type ExecutionSummary, type SessionView, type SignInOptions } from "../../emergency/executor-client";
import type { SnapshotRecord } from "../../emergency/snapshot";
import { relativeTime } from "../format";
import { AdminPage } from "./AdminPage";
import { ExecutionPage } from "./ExecutionPage";
import { PrepareSnapshot } from "./PrepareSnapshot";
import { SnapshotPage } from "./SnapshotPage";
import { emergencyHref, type EmergencyRoute } from "./route";
import "./emergency.css";

export { emergencyHref } from "./route";

export function errorText(error: unknown): string {
  if (error instanceof ExecutorError) {
    const details = Array.isArray(error.details) ? error.details.map((d) => (typeof d === "string" ? d : (d as { message?: string }).message ?? JSON.stringify(d))) : [];
    return [error.message, ...details].join(" — ");
  }
  return error instanceof Error ? error.message : String(error);
}

const SessionContext = createContext<SessionView | null>(null);
/** The signed-in user (always set inside the signed-in emergency pages). */
export const useSession = () => useContext(SessionContext)!;
export const can = (session: SessionView | null, permission: string) => session?.permissions.includes(permission) ?? false;

export function EmergencyView({ env, route, githubConnected }: { env: Environment; route: EmergencyRoute; githubConnected: boolean }) {
  const [signIn, setSignIn] = useState<SignInOptions | null | undefined>(undefined);
  const [session, setSession] = useState<SessionView | null | undefined>(undefined);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    void executor.available().then(async (a) => {
      if (!live) return;
      setSignIn(a);
      if (a) {
        const s = await executor.session().catch(() => null);
        if (live) setSession(s);
      }
    });
    return () => {
      live = false;
    };
  }, [reload]);

  return (
    <div className="emergency">
      <header className="emergency-head">
        <div>
          <p className="emergency-kicker">Emergency execution</p>
          <h2>
            <a href="#/emergency">Run prepared pipelines without GitHub Actions</a>
          </h2>
          <p className="muted">
            Separate from the read-only investigation views. Snapshots are prepared while GitHub is available and run later as Kubernetes Jobs, with no access to GitHub. Only the
            supported subset of GitHub Actions runs; anything else is refused when the snapshot is validated.
          </p>
        </div>
        {session && (
          <div className="emergency-user" data-testid="signed-in-user">
            <span>
              {session.user.name}
              {session.session.method === "break-glass" && <span className="tag tag-bad"> break-glass</span>}
            </span>
            <span className="muted" data-testid="user-roles">
              {session.roles.length ? session.roles.join(", ") : "no roles yet"}
            </span>
            {session.roles.includes("administrator") && <a href={emergencyHref({ page: "admin" })}>Administration</a>}
            <button
              type="button"
              onClick={() => {
                void executor.signOut().finally(() => setReload((n) => n + 1));
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      {signIn === undefined || (signIn && session === undefined) ? (
        <p className="state">Looking for the emergency executor…</p>
      ) : !signIn ? (
        <p className="state state-error" role="alert" data-testid="emergency-unavailable">
          Emergency execution isn't available in this deployment: no executor answers at <code>api/emergency/</code>. It is installed separately (charts/gha-emergency).
        </p>
      ) : !session ? (
        <SignIn options={signIn} failed={route.page === "sign-in-failed"} onSignedIn={() => setReload((n) => n + 1)} />
      ) : session.roles.length === 0 ? (
        <NoRoles session={session} />
      ) : (
        <SessionContext.Provider value={session}>
          {route.page === "prepare" ? (
            <PrepareSnapshot env={env} githubConnected={githubConnected} />
          ) : route.page === "snapshot" ? (
            <SnapshotPage id={route.id} env={env} githubConnected={githubConnected} />
          ) : route.page === "execution" ? (
            <ExecutionPage id={route.id} />
          ) : route.page === "admin" ? (
            <AdminPage />
          ) : (
            <EmergencyHome />
          )}
        </SessionContext.Provider>
      )}
    </div>
  );
}

function SignIn({ options, failed, onSignedIn }: { options: SignInOptions; failed: boolean; onSignedIn: () => void }) {
  const [account, setAccount] = useState("");
  const [credential, setCredential] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const returnTo = window.location.hash.startsWith("#/emergency") && !failed ? window.location.hash : "#/emergency";
  return (
    <div className="panel emergency-connect" data-testid="sign-in">
      <h3>Sign in to the emergency executor</h3>
      {failed && (
        <p className="state state-error" role="alert" data-testid="sign-in-failed">
          Sign-in failed. Try again; if it keeps failing, an administrator can see why in the executor's audit log.
        </p>
      )}
      {options.oidc ? (
        <p>
          <a className="button-link" href={signInUrl(returnTo)} data-testid="sign-in-oidc">
            Sign in with {options.oidc.label}
          </a>
        </p>
      ) : (
        <p className="muted">No identity provider is configured on this executor.</p>
      )}
      <p className="muted">Your session is kept by the executor in a cookie this page can't read. It is not your GitHub token, and the executor never receives your GitHub token.</p>
      {options.breakGlass && (
        <details data-testid="break-glass">
          <summary>Break-glass sign-in (identity provider unavailable)</summary>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await executor.breakGlass(account.trim(), credential, reason.trim());
                setCredential("");
                onSignedIn();
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <p className="muted">Every break-glass sign-in is audited with its reason and lasts at most an hour.</p>
            <label>
              Account
              <input value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="off" spellCheck={false} data-testid="break-glass-account" required />
            </label>
            <label>
              Credential
              <input type="password" value={credential} onChange={(e) => setCredential(e.target.value)} autoComplete="off" data-testid="break-glass-credential" required />
            </label>
            <label>
              Reason (incident, approval)
              <input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="break-glass-reason" required minLength={10} />
            </label>
            <button type="submit" disabled={busy || !account.trim() || !credential || reason.trim().length < 10}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            {error && (
              <p className="state state-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </details>
      )}
    </div>
  );
}

function NoRoles({ session }: { session: SessionView }) {
  return (
    <div className="panel" data-testid="no-roles">
      <h3>Signed in, with no roles yet</h3>
      <p>An administrator must give you a role (viewer, operator, approver or administrator) before you can see or run anything. Tell them who you are:</p>
      <dl className="manifest-facts">
        <dt>Name</dt>
        <dd>{session.user.name}</dd>
        <dt>Issuer</dt>
        <dd className="mono">{session.user.issuer ?? session.user.kind}</dd>
        <dt>Subject</dt>
        <dd className="mono" data-testid="my-subject">
          {session.user.subject ?? session.user.id}
        </dd>
      </dl>
    </div>
  );
}

function EmergencyHome() {
  const session = useSession();
  const [snapshots, setSnapshots] = useState<SnapshotRecord[] | null>(null);
  const [executions, setExecutions] = useState<ExecutionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all([executor.listSnapshots(), executor.listExecutions()]).then(
      ([s, x]) => {
        if (!live) return;
        setSnapshots(s);
        setExecutions(x);
        setError(null);
      },
      (err) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [reload]);

  return (
    <div className="emergency-home">
      <section className="panel">
        <div className="panel-head">
          <h3>Snapshots</h3>
          {can(session, "snapshots.create") && (
            <a className="button-link" href={emergencyHref({ page: "prepare" })} data-testid="prepare-link">
              Prepare a snapshot
            </a>
          )}
        </div>
        {error && <p className="state state-error">{error}</p>}
        {snapshots === null ? (
          <p className="state">Loading…</p>
        ) : snapshots.length === 0 ? (
          <p className="muted">No snapshots yet. Prepare one while GitHub is available.</p>
        ) : (
          <table className="emergency-table" data-testid="snapshot-list">
            <thead>
              <tr>
                <th>Snapshot</th>
                <th>Source</th>
                <th>Prepared</th>
                <th>By</th>
                <th>Expires</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id}>
                  <td>
                    <a href={emergencyHref({ page: "snapshot", id: s.id })}>
                      {s.name} <span className="muted">v{s.version}</span>
                    </a>
                  </td>
                  <td className="mono">
                    {s.source.repository}@{s.source.sha.slice(0, 7)}
                  </td>
                  <td>{relativeTime(s.storedAt)}</td>
                  <td>
                    {s.preparedBy?.name ?? <span className="muted">before sign-in</span>}
                    {s.visibility === "restricted" && <span className="tag"> restricted</span>}
                  </td>
                  <td>{new Date(s.expiresAt).toISOString().slice(0, 10)}</td>
                  <td>{s.executable ? <span className="tag tag-ok">executable</span> : <span className="tag tag-bad">validation errors</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <h3>Executions</h3>
          <button type="button" onClick={() => setReload((n) => n + 1)}>
            Refresh
          </button>
        </div>
        {executions === null ? (
          <p className="state">Loading…</p>
        ) : executions.length === 0 ? (
          <p className="muted">No executions yet.</p>
        ) : (
          <table className="emergency-table" data-testid="execution-list">
            <thead>
              <tr>
                <th>Execution</th>
                <th>Snapshot</th>
                <th>Workflow</th>
                <th>Requested</th>
                <th>By</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {executions.map((x) => (
                <tr key={x.meta.id}>
                  <td className="mono">
                    <a href={emergencyHref({ page: "execution", id: x.meta.id })}>{x.meta.id}</a>
                  </td>
                  <td>
                    {x.meta.snapshotName} v{x.meta.snapshotVersion}
                  </td>
                  <td className="mono">{x.meta.workflow}</td>
                  <td>{relativeTime(x.meta.createdAt)}</td>
                  <td>{x.meta.initiatedBy?.name ?? <span className="muted">operator token</span>}</td>
                  <td>
                    {x.meta.state === "awaiting-approval" ? <span className="tag tag-run">awaiting approval</span> : <StatusTag status={x.status} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export function StatusTag({ status }: { status: string }) {
  const cls = status === "success" ? "tag-ok" : status === "failure" || status === "error" ? "tag-bad" : status === "running" || status === "pending" ? "tag-run" : "";
  return (
    <span className={`tag ${cls}`} data-testid="status-tag">
      {status}
    </span>
  );
}
