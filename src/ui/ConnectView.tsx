// The landing page in live mode: what the app is, a real screenshot of it, what it reads, and the token form.
import { useRef, useState } from "react";
import { patProvider } from "../auth/pat-provider";
// Screenshots of this app's execution graph on a SYNTHETIC demo run (regenerate with CAPTURE_SHOWCASE=1; see
// tests/e2e/capture-showcase.spec.ts).
import showcaseDark from "./assets/showcase-dark.png";
import showcaseLight from "./assets/showcase-light.png";

const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

const BENEFITS: { title: string; text: string; icon: string }[] = [
  {
    title: "See where a run stopped",
    text: "Each deployment environment of a run at a glance, grouped from your own workflow's environments: what passed, what failed, what was rolled back, and why the rest never ran.",
    icon: "M3 12h4l3-8 4 16 3-8h4",
  },
  {
    title: "Dependencies as they really are",
    text: "Jobs and their needs, read from the workflow files the run used, through reusable workflows in any repository. Parallel branches, matrices and deployment-only runs: the graph follows your structure, never a template.",
    icon: "M6 6h4v4H6zM14 14h4v4h-4zM14 4h4v4h-4zM10 8l4-2M10 8l4 8",
  },
  {
    title: "From failure to the line that explains it",
    text: "The failed step, GitHub's annotations and recognised error signatures, ranked so the real cause comes first. One click opens the log at that line.",
    icon: "M12 3l9 16H3zM12 10v4M12 17v.5",
  },
];

const ALSO: [string, string][] = [
  ["Timeline", "what ran in parallel, what waited, and the critical path"],
  ["Run attempts", "each re-run attempt with its own jobs, results and logs"],
  ["Workflow source", "the exact files and revisions behind a run; secret-like inputs hidden"],
  ["Log viewer", "search, errors only, step sections and links to any line, even in very large logs"],
];

function Icon({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}
const CHECK = "M5 12.5l4.5 4.5L19 7.5";

/** The token is read from the field once on submit, handed to the PAT provider, and the field is cleared. */
export function ConnectView({ onConnected }: { onConnected(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const field = input.current;
    if (!field) return;
    try {
      patProvider.connect(field.value);
      field.value = "";
      onConnected();
    } catch {
      setError("Enter a token.");
    }
  }
  const toConnect = (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById("connect")?.scrollIntoView({ behavior: "smooth", block: "start" });
    input.current?.focus({ preventScroll: true });
  };

  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">GitHub Actions UI · open source</p>
          <h2 className="hero-title">
            Understand how your GitHub Actions runs <span className="hero-accent">actually executed.</span>
          </h2>
          <p className="hero-lede">
            Follow a run through its jobs, reusable workflows and environments, see exactly where it stopped, and open the log at the line that explains why.
            Everything is built from your workflow files and GitHub's own run data, so it adapts to however your pipelines are structured.
          </p>
          <div className="hero-cta">
            <a className="btn btn-primary" href="#connect" onClick={toConnect}>
              Connect to GitHub
            </a>
            {__FIXTURE_MODE__ && (
              <a className="btn" href="?mode=fixtures">
                Explore the demo
              </a>
            )}
          </div>
          <ul className="trust" aria-label="Security">
            <li>
              <Icon d={CHECK} size={16} /> Read-only: GET and HEAD requests only
            </li>
            <li>
              <Icon d={CHECK} size={16} /> Token held in memory, never stored
            </li>
            <li>
              <Icon d={CHECK} size={16} /> No backend, no telemetry
            </li>
          </ul>
        </div>

        <figure className="showcase">
          <div className="showcase-frame">
            <div className="showcase-bar">
              <span>Execution graph</span>
              <span className="tag">synthetic demo run</span>
            </div>
            <a className="shot-light" href={showcaseLight} target="_blank" rel="noreferrer" title="Open the screenshot at full size">
              <img
                src={showcaseLight}
                alt="Execution graph of a synthetic run: CI, then DEV, then PROD and PROD-DR deployed in parallel through reusable workflows; the PROD-DR validation failed and its rollback ran."
              />
            </a>
            <a className="shot-dark" href={showcaseDark} target="_blank" rel="noreferrer" title="Open the screenshot at full size">
              <img
                src={showcaseDark}
                alt="Execution graph of a synthetic run: CI, then DEV, then PROD and PROD-DR deployed in parallel through reusable workflows; the PROD-DR validation failed and its rollback ran."
              />
            </a>
          </div>
          <figcaption>
            A synthetic demo run: shared CI/CD workflows called from another repository, PROD and PROD-DR promoted in parallel, one failed validation and the
            rollback it triggered. Groups come from the run's own environments.
          </figcaption>
        </figure>
      </section>

      <section aria-labelledby="benefits-heading">
        <h2 className="section-title" id="benefits-heading">
          What it shows you
        </h2>
        <div className="benefits">
          {BENEFITS.map((b) => (
            <article key={b.title} className="benefit">
              <span className="feature-icon">
                <Icon d={b.icon} />
              </span>
              <h3>{b.title}</h3>
              <p>{b.text}</p>
            </article>
          ))}
        </div>
        <ul className="also" aria-label="Also included">
          {ALSO.map(([name, text]) => (
            <li key={name}>
              <b>{name}</b>: {text}
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-grid" id="connect">
        <section className="panel connect" aria-labelledby="connect-heading">
          <h2 id="connect-heading">Connect to GitHub</h2>
          <p className="muted">Paste a fine-grained personal access token. It is sent only to the GitHub API.</p>
          <form onSubmit={submit} autoComplete="off">
            <label htmlFor="token">Fine-grained personal access token (read-only)</label>
            <input id="token" ref={input} type="password" autoComplete="off" spellCheck={false} placeholder="github_pat_…" data-testid="token-input" />
            <button type="submit" className="btn-primary">
              Connect
            </button>
          </form>
          {error && <p className="state state-error">{error}</p>}
          <ul className="note connect-notes">
            <li>The token is kept in memory only. Reloading the page or choosing Disconnect forgets it.</li>
            <li>This app only reads. It never re-runs, cancels or changes anything on GitHub.</li>
          </ul>
          {__FIXTURE_MODE__ && (
            <p>
              <a href="?mode=fixtures">Or explore with demo data (fixture mode, no token)</a>
            </p>
          )}
        </section>

        <section className="token-steps" aria-labelledby="token-steps-heading">
          <h3 id="token-steps-heading">Create a token</h3>
          <ol>
            <li>
              Open{" "}
              <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer noopener">
                GitHub → Fine-grained tokens → Generate new token
              </a>
              .
            </li>
            <li>Choose the repositories you want to inspect.</li>
            <li>
              Under <b>Repository permissions</b>, set these to <b>Read-only</b>:
              <div className="perm-list">
                <span>Actions</span>
                <span>Contents</span>
                <span>Metadata</span>
              </div>
              <span className="muted">Contents is used to read workflow files at the commit each run used.</span>
            </li>
            <li>Generate the token, copy it, and paste it here.</li>
          </ol>
        </section>
      </section>

      <footer className="landing-foot">
        GitHub stays the source of truth: every view links back to it. Apache-2.0 ·{" "}
        <a href="https://github.com/GauJosh/github-actions-ui" target="_blank" rel="noreferrer noopener">
          Source on GitHub
        </a>
      </footer>
    </div>
  );
}
