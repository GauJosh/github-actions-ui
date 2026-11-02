// Administration of emergency execution (security review H2), for administrators: other users' roles and sessions,
// suspending Secret bindings, and the audit log. The executor enforces all of it: it refuses these calls from anyone
// else, and refuses changes to your own roles or account.
import { useEffect, useState } from "react";
import { executor, type AuditEntryView, type BindingView, type Role, type UserView } from "../../emergency/executor-client";
import { relativeTime } from "../format";
import { errorText, useSession } from "./EmergencyView";

const ROLE_HELP: Record<Role, string> = {
  viewer: "sees shared snapshots, executions and logs",
  operator: "prepares snapshots and starts executions",
  approver: "approves sensitive executions (not their own)",
  administrator: "manages users, sessions, bindings; reads the audit log",
};

export function AdminPage() {
  const session = useSession();
  const [users, setUsers] = useState<UserView[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [bindings, setBindings] = useState<BindingView[] | null>(null);
  const [audit, setAudit] = useState<AuditEntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [reason, setReason] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    Promise.all([executor.listUsers(), executor.listBindings(), executor.audit()]).then(
      ([u, b, a]) => {
        if (!live) return;
        setUsers(u.users);
        setRoles(u.roles);
        setBindings(b.bindings);
        setAudit(a);
        setError(null);
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [reload]);
  const act = (f: () => Promise<unknown>) => void f().then(() => setReload((n) => n + 1), (e) => setError(errorText(e)));

  return (
    <div className="emergency-admin" data-testid="admin-page">
      <p>
        <a href="#/emergency">← Emergency execution</a>
      </p>
      {error && (
        <p className="state state-error" role="alert">
          {error}
        </p>
      )}
      <section className="panel">
        <h3>Users and roles</h3>
        <p className="muted">
          Users appear here after their first sign-in. Roles: {roles.map((r) => `${r} (${ROLE_HELP[r]})`).join("; ")}. Pinned roles come from the chart's configuration and can't be removed here. You can't change your own roles or account.
        </p>
        {!users ? (
          <p className="state">Loading…</p>
        ) : (
          <table className="emergency-table" data-testid="user-list">
            <thead>
              <tr>
                <th>User</th>
                <th>Identity</th>
                <th>Roles</th>
                <th>Last seen</th>
                <th>Sessions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === session.user.id;
                return (
                  <tr key={u.id} data-testid={`user-${u.name}`}>
                    <td>
                      {u.name}
                      {u.disabled && <span className="tag tag-bad"> disabled</span>}
                    </td>
                    <td className="mono">{u.kind === "break-glass" ? `break-glass: ${u.account}` : `${u.issuer} ${u.subject}`}</td>
                    <td>
                      {roles.map((r) => (
                        <label key={r} className="role-check">
                          <input
                            type="checkbox"
                            checked={u.effectiveRoles.includes(r)}
                            disabled={self || u.pinnedRoles.includes(r) || u.kind === "break-glass"}
                            onChange={(e) => act(() => executor.setRoles(u.id, e.target.checked ? [...u.roles, r] : u.roles.filter((x) => x !== r)))}
                            data-testid={`role-${u.name}-${r}`}
                          />{" "}
                          {r}
                        </label>
                      ))}
                    </td>
                    <td>{relativeTime(u.lastSeen)}</td>
                    <td>{u.sessions}</td>
                    <td>
                      {!self && (
                        <>
                          <button type="button" onClick={() => act(() => executor.revokeSessions(u.id))} disabled={u.sessions === 0}>
                            End sessions
                          </button>{" "}
                          <button type="button" className={u.disabled ? "" : "danger"} onClick={() => act(() => executor.setDisabled(u.id, !u.disabled))}>
                            {u.disabled ? "Enable" : "Disable"}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      <section className="panel">
        <h3>Secret bindings</h3>
        <p className="muted">Bindings are created in the chart's values by a cluster administrator (and pinned at admission). Here you can suspend one, which stops it giving any execution its Secret and invalidates approvals that relied on it, and resume it.</p>
        {!bindings ? (
          <p className="state">Loading…</p>
        ) : bindings.length === 0 ? (
          <p className="muted">No bindings.</p>
        ) : (
          <table className="emergency-table" data-testid="binding-list">
            <thead>
              <tr>
                <th>Binding</th>
                <th>Secret and keys</th>
                <th>Snapshots</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bindings.map((b) => (
                <tr key={b.name}>
                  <td className="mono">{b.name}</td>
                  <td className="mono">
                    {b.secret}: {b.keys.join(", ")}
                  </td>
                  <td className="mono">{b.snapshots.map((d) => d.slice(0, 12)).join(", ")}</td>
                  <td>{b.suspension?.suspended ? <span className="tag tag-bad" title={`${b.suspension.by.name}: ${b.suspension.reason}`}>suspended</span> : <span className="tag tag-ok">active</span>}</td>
                  <td>
                    <input placeholder="Reason" value={reason[b.name] ?? ""} onChange={(e) => setReason({ ...reason, [b.name]: e.target.value })} />{" "}
                    <button type="button" disabled={(reason[b.name] ?? "").trim().length < 5} onClick={() => act(() => executor.setBindingSuspended(b.name, !b.suspension?.suspended, reason[b.name]!.trim()))}>
                      {b.suspension?.suspended ? "Resume" : "Suspend"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="panel">
        <h3>Audit log</h3>
        {!audit ? (
          <p className="state">Loading…</p>
        ) : (
          <table className="emergency-table" data-testid="audit-list">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>By</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((e, i) => {
                const { at, action, by, ...rest } = e;
                return (
                  <tr key={i}>
                    <td title={at}>{relativeTime(at)}</td>
                    <td className="mono">{action}</td>
                    <td>{by?.name ?? "—"}</td>
                    <td className="mono audit-details">{JSON.stringify(rest)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
