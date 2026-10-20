// Fixture-mode run list. Rendered only behind __FIXTURE_MODE__, so production bundles do not include it.
import { useQuery } from "@tanstack/react-query";
import { routeToHash } from "../domain/run-url";

type FixtureEntry = { owner: string; repo: string; runId: number; title: string; conclusion: string };

export function FixtureIndex() {
  const index = useQuery({
    queryKey: ["fixture-index"],
    queryFn: async (): Promise<FixtureEntry[]> => {
      const response = await fetch("/__fixtures/index", { cache: "no-store" });
      const body = (await response.json()) as FixtureEntry[] | { message: string };
      if (!response.ok || !Array.isArray(body)) throw new Error("message" in body ? body.message : `HTTP ${response.status}`);
      return body;
    },
    retry: false,
  });
  if (index.isPending) return <p className="note">Loading fixture runs…</p>;
  if (index.isError) {
    return (
      <p className="state state-error" role="alert">
        {index.error.message}
      </p>
    );
  }
  const failed = index.data.filter((e) => e.conclusion !== "success");
  return (
    <details className="fixture-index" open>
      <summary>Demo runs that did not succeed ({failed.length})</summary>
      <ul>
        {failed.map((e) => (
          <li key={e.runId}>
            <a href={routeToHash({ run: e })}>{e.title}</a>{" "}
            <span className="muted">
              {e.owner}/{e.repo} · {e.conclusion}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function FixtureBanner() {
  return (
    <div className="banner" role="note" data-testid="fixture-banner">
      Demo data (fixture mode): runs and logs come from the pinned fixture corpus. No requests go to GitHub. <a href="./">Exit demo</a>
    </div>
  );
}
