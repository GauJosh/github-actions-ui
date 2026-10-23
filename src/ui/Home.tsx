// Repository selection, for tokens that see a handful of repositories or thousands:
// - one search box. An exact "owner/repo" opens directly (checked with one request). Anything else is searched by
//   GitHub across every repository the token can see, optionally within one owner ("org/" or "org/part");
// - with nothing typed, one page of the most recently pushed repositories; more pages only on request;
// - "no match" is said only when GitHub's search found nothing, never because a match is on a page not loaded yet.
// A run URL remains a shortcut, not the main entry point.
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Environment } from "../app/environment";
import { parseRepo, parseRunUrl, routeToHash } from "../domain/run-url";
import type { Repository } from "../domain/types";
import { DemoGallery } from "../fixture-mode/gallery";
import { GitHubError } from "../github/client";
import { failureText } from "./copy";
import { relativeTime } from "./format";

export function Home({ env }: { env: Environment }) {
  return (
    <div className="home">
      <header className="home-intro">
        <h2>Pick a repository</h2>
        <p className="muted">Find one by name, or jump straight to a run from its GitHub URL.</p>
      </header>
      {__FIXTURE_MODE__ && env.mode === "fixtures" && (
        <div className="home-gallery">
          <DemoGallery />
        </div>
      )}
      <RepoFinder env={env} />
      <aside className="home-side">
        <OpenRunUrl />
      </aside>
    </div>
  );
}

/** The search text, split into an optional owner ("org/…") and the name part; `exact` for a full owner/repo. */
export function parseQuery(text: string): { owner?: string; term: string; exact?: { owner: string; repo: string } } {
  const t = text
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    // "org/repo/" (e.g. a pasted URL) loses its trailing slash; "org/" keeps it, meaning "within org".
    .replace(/^([^/]+\/[^/]+)\/$/, "$1");
  const slash = t.indexOf("/");
  if (slash < 0) return { term: t };
  const owner = t.slice(0, slash);
  const rest = t.slice(slash + 1);
  const exact = rest ? parseRepo(`${owner}/${rest}`) : null;
  return { owner: owner || undefined, term: rest, ...(exact && { exact }) };
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

const repoHref = (r: Repository) => routeToHash({ repo: { owner: r.owner.login, repo: r.name } });

function RepoRow({ r }: { r: Repository }) {
  return (
    <li>
      <a href={repoHref(r)} className="repo-link">
        <span className="repo-name">{r.full_name}</span>
        {r.private && <span className="tag">private</span>}
        {r.description && <span className="repo-desc">{r.description}</span>}
        {r.pushed_at && <span className="muted">pushed {relativeTime(r.pushed_at)}</span>}
      </a>
    </li>
  );
}

type SearchData = { totalCount: number; incomplete: boolean; repos: Repository[] };

function RepoFinder({ env }: { env: Environment }) {
  const [text, setText] = useState("");
  const q = useDebounced(text, 350);
  const query = useMemo(() => parseQuery(q), [q]);
  const typed = text.trim().length > 0;
  const settled = q === text;

  // Nothing typed: the most recently pushed repositories, one page at a time.
  const recent = useInfiniteQuery({
    queryKey: ["repos", env.mode],
    queryFn: ({ pageParam }) => env.client.listRepos(pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.hasNext ? all.length + 1 : undefined),
  });
  const loaded = useMemo(() => recent.data?.pages.flatMap((p) => p.repos) ?? [], [recent.data]);

  // An exact owner/repo: is it there, and can this token see it?
  const exact = useQuery({
    queryKey: ["repo", env.mode, query.exact?.owner.toLowerCase(), query.exact?.repo.toLowerCase()],
    queryFn: () => env.client.getRepo(query.exact!),
    enabled: Boolean(query.exact),
    retry: false,
    staleTime: 60_000,
  });
  // Everything else (and alongside an exact name): GitHub's search, by name, optionally within one owner.
  const searchable = query.term.length >= 2 || (Boolean(query.owner) && query.term.length === 0);
  const search = useQuery({
    queryKey: ["repo-search", env.mode, query.owner?.toLowerCase(), query.term.toLowerCase()],
    queryFn: () => env.client.searchRepos(query.term, query.owner),
    enabled: searchable,
    retry: false,
    staleTime: 60_000,
  });

  // Matches among repositories already loaded show at once; search results follow, without duplicates.
  const needle = text.trim().toLowerCase();
  const local = typed ? loaded.filter((r) => r.full_name.toLowerCase().includes(needle)) : [];
  const seen = new Set<string>();
  const results: Repository[] = [];
  for (const r of [...(exact.data && settled ? [exact.data] : []), ...local, ...(settled && search.data ? search.data.repos : [])]) {
    const k = r.full_name.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      results.push(r);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // Enter on an exact owner/repo opens it directly, whether or not any list contains it.
    const direct = parseQuery(text).exact;
    if (direct) window.location.hash = routeToHash({ repo: direct });
    else if (results[0]) window.location.hash = repoHref(results[0]);
  }

  const searching = typed && (!settled || search.isFetching || exact.isFetching);
  const exactMissing =
    Boolean(query.exact) && settled && exact.isError && exact.error instanceof GitHubError && exact.error.failure.kind === "not-found-or-no-permission";

  return (
    <section className="panel repo-list" aria-labelledby="repos-heading">
      <header className="panel-head">
        <h2 id="repos-heading">Repositories</h2>
        {!typed && (
          <button onClick={() => void recent.refetch()} disabled={recent.isFetching}>
            {recent.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </header>
      <form onSubmit={submit} className="repo-search" role="search">
        <input
          className="filter-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="org/repo, org/part-of-a-name, or part-of-a-name"
          aria-label="Find a repository"
          aria-describedby="repo-search-hint"
          autoComplete="off"
          spellCheck={false}
          data-testid="repo-search"
        />
      </form>
      <p id="repo-search-hint" className="note">
        Searches every repository your token can see, by name. Type <code>org/</code> to search within one organisation; an exact <code>org/repo</code>{" "}
        opens with Enter.
      </p>

      {typed ? (
        <div data-testid="repo-results">
          <p className="note" role="status" data-testid="repo-search-status">
            {searchStatus({ searching, searchable, data: search.data, failed: search.isError, results: results.length, term: text.trim() })}
          </p>
          {exactMissing && (
            <p className="state state-error" data-testid="repo-not-found">
              {query.exact!.owner}/{query.exact!.repo} was not found, or this token cannot see it. A fine-grained token sees only the repositories it was granted,
              and an organisation with single sign-on must authorise the token.
            </p>
          )}
          {search.isError && settled && (
            <p className="state state-error" role="alert">
              GitHub&apos;s search could not be used: {search.error instanceof GitHubError ? failureText(search.error.failure) : "an unexpected error."}
              {query.exact ? "" : " An exact org/repo still opens directly with Enter."}
            </p>
          )}
          {results.length > 0 && (
            <ul className="repos" data-testid="repo-list">
              {results.map((r) => (
                <RepoRow key={r.full_name} r={r} />
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <h3 className="repo-section">Recently active</h3>
          {recent.isPending && <p className="state">Loading repositories your token can access…</p>}
          {recent.isError && (
            <div className="state state-error" role="alert">
              <p>{repoListError(recent.error)}</p>
              <p className="note">You can still find a repository by name above, or open one directly as org/repo.</p>
            </div>
          )}
          {recent.isSuccess &&
            (loaded.length === 0 ? (
              <p className="state">No repositories are visible to this token. Fine-grained tokens list only the repositories they were granted.</p>
            ) : (
              <ul className="repos" data-testid="repo-list">
                {loaded.map((r) => (
                  <RepoRow key={r.full_name} r={r} />
                ))}
              </ul>
            ))}
          {recent.hasNextPage && (
            <button onClick={() => void recent.fetchNextPage()} disabled={recent.isFetchingNextPage}>
              {recent.isFetchingNextPage ? "Loading…" : "Show more recently active"}
            </button>
          )}
          {recent.isFetchNextPageError && (
            <p className="state state-error" role="alert">
              More repositories could not be loaded. {repoListError(recent.error)}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function searchStatus(s: { searching: boolean; searchable: boolean; data?: SearchData; failed: boolean; results: number; term: string }): string {
  if (s.searching) return "Searching all repositories your token can see…";
  if (!s.searchable)
    return s.results
      ? `${s.results} loaded repositor${s.results === 1 ? "y matches" : "ies match"}. Type at least 2 characters to search all of them.`
      : "Type at least 2 characters to search.";
  if (s.failed || !s.data) return "";
  const { totalCount, incomplete, repos } = s.data;
  if (s.results === 0) return `GitHub's search found no repository named like “${s.term}” that this token can see.`;
  const more = totalCount > repos.length ? ` Showing the best ${repos.length} of ${totalCount}; type more of the name to narrow it.` : "";
  const partial = incomplete ? " GitHub reported incomplete results (its search timed out); try again or narrow the name." : "";
  return `${totalCount} match${totalCount === 1 ? "" : "es"} in GitHub's search.${more}${partial}`;
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
    window.location.hash = routeToHash({ run: { owner: ref.owner, repo: ref.repo, runId: ref.runId }, jobId: ref.jobId, attempt: ref.attempt });
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
