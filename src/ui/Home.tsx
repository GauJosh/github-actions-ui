// Repository selection: repositories the token can see, plus an explicit owner/repo entry that works even
// when the token cannot list repositories. A run URL remains a shortcut, not the main entry point.
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Environment } from "../app/environment";
import { parseRepo, parseRunUrl, routeToHash } from "../domain/run-url";
import { DemoGallery } from "../fixture-mode/gallery";
import { GitHubError } from "../github/client";
import { failureText } from "./copy";
import { relativeTime } from "./format";

export function Home({ env }: { env: Environment }) {
  return (
    <div className="home">
      {__FIXTURE_MODE__ && env.mode === "fixtures" && (
        <div className="home-gallery">
          <DemoGallery />
        </div>
      )}
      <RepoList env={env} />
      <aside className="home-side">
        <OpenRepo />
        <OpenRunUrl />
      </aside>
    </div>
  );
}

function RepoList({ env }: { env: Environment }) {
  const [filter, setFilter] = useState("");
  const repos = useInfiniteQuery({
    queryKey: ["repos", env.mode],
    queryFn: ({ pageParam }) => env.client.listRepos(pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.hasNext ? all.length + 1 : undefined),
  });
  const all = useMemo(() => repos.data?.pages.flatMap((p) => p.repos) ?? [], [repos.data]);
  const shown = all.filter((r) => r.full_name.toLowerCase().includes(filter.trim().toLowerCase()));
  const nextPageError = repos.isFetchNextPageError ? repos.error : null;

  return (
    <section className="panel repo-list" aria-labelledby="repos-heading">
      <header className="panel-head">
        <h2 id="repos-heading">Repositories</h2>
        <button onClick={() => void repos.refetch()} disabled={repos.isFetching}>
          {repos.isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      {repos.isPending && <p className="state">Loading repositories your token can access…</p>}
      {repos.isError && (
        <div className="state state-error" role="alert">
          <p>{repoListError(repos.error)}</p>
          <p className="note">You can still open a repository by name (on the right).</p>
        </div>
      )}
      {repos.isSuccess && (
        <>
          <input
            className="filter-input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${all.length} repositories`}
            aria-label="Filter repositories"
          />
          {all.length === 0 ? (
            <p className="state">No repositories are visible to this token. Fine-grained tokens list only the repositories they were granted.</p>
          ) : shown.length === 0 ? (
            <p className="state">No repositories match “{filter}”.</p>
          ) : (
            <ul className="repos" data-testid="repo-list">
              {shown.map((r) => (
                <li key={r.full_name}>
                  <a href={routeToHash({ repo: { owner: r.owner.login, repo: r.name } })} className="repo-link">
                    <span className="repo-name">{r.full_name}</span>
                    {r.private && <span className="tag">private</span>}
                    {r.description && <span className="repo-desc">{r.description}</span>}
                    {r.pushed_at && <span className="muted">pushed {relativeTime(r.pushed_at)}</span>}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {repos.hasNextPage && (
            <button onClick={() => void repos.fetchNextPage()} disabled={repos.isFetchingNextPage}>
              {repos.isFetchingNextPage ? "Loading…" : "Load more repositories"}
            </button>
          )}
          {nextPageError && (
            <p className="state state-error" role="alert">
              More repositories could not be loaded. {repoListError(nextPageError)}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function repoListError(error: unknown): string {
  if (error instanceof GitHubError) {
    if (error.failure.kind === "permission" || error.failure.kind === "not-found-or-no-permission") {
      return "This token cannot list repositories. That is expected for some fine-grained tokens; nothing broader is assumed.";
    }
    return failureText(error.failure);
  }
  return "Repositories could not be loaded.";
}

function OpenRepo() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const repo = parseRepo(value);
    if (!repo) {
      setError("Enter a repository as OWNER/REPO, for example GauJosh/gha-ui-fixtures.");
      return;
    }
    setError(null);
    window.location.hash = routeToHash({ repo });
  }
  return (
    <section className="panel">
      <h3>Open a repository</h3>
      <form onSubmit={submit}>
        <label htmlFor="repo-input" className="visually-hidden">
          Repository (owner/repo)
        </label>
        <input id="repo-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="owner/repo" />
        <button type="submit">Open</button>
      </form>
      {error && <p className="state state-error">{error}</p>}
    </section>
  );
}

function OpenRunUrl() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const ref = parseRunUrl(value);
    if (!ref) {
      setError("Paste a run URL like https://github.com/OWNER/REPO/actions/runs/123456789");
      return;
    }
    setError(null);
    window.location.hash = routeToHash({ run: ref, jobId: ref.jobId });
  }
  return (
    <section className="panel">
      <h3>Shortcut: open a run URL</h3>
      <form onSubmit={submit}>
        <label htmlFor="run-url" className="visually-hidden">
          GitHub Actions run URL
        </label>
        <input id="run-url" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://github.com/OWNER/REPO/actions/runs/123" />
        <button type="submit">Open run</button>
      </form>
      {error && <p className="state state-error">{error}</p>}
    </section>
  );
}
