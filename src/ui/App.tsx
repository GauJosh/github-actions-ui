import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createEnvironment, modeFromLocation, type Mode } from "../app/environment";
import { patProvider } from "../auth/pat-provider";
import { parseHash } from "../domain/run-url";
import { FixtureBanner } from "../fixture-mode/FixtureBanner";
import { ConnectView } from "./ConnectView";
import { RunExplorer } from "./explorer/RunExplorer";
import { Home } from "./Home";
import { RepoDashboard } from "./RepoDashboard";

const subscribeHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/** The app's mark: three connected jobs. */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <rect width="32" height="32" rx="8" className="mark-bg" />
      <path d="M10 11h5l3 10h4" fill="none" className="mark-line" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9" cy="11" r="3" className="mark-node" />
      <circle cx="23" cy="21" r="3" className="mark-node" />
      <circle cx="23" cy="11" r="2.2" className="mark-node dim" />
    </svg>
  );
}

type Theme = "system" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

/** Light, dark or the system's choice. Kept for this page view only: the app stores nothing in the browser. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <button type="button" className="theme-toggle" onClick={() => setTheme(NEXT[theme])} title="Switch between system, light and dark themes" data-testid="theme-toggle">
      <span aria-hidden="true">{theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}</span> Theme: {theme}
    </button>
  );
}

function Brand() {
  return (
    <h1 className="brand">
      <a href="#/">
        <Mark />
        <span>GitHub Actions UI</span>
      </a>
    </h1>
  );
}

export function App() {
  const mode = modeFromLocation(window.location.search);
  if (mode === "fixtures-unavailable") {
    return (
      <div className="app">
        <header className="topbar">
          <Brand />
          <ThemeToggle />
        </header>
        <p className="state state-error" role="alert">
          Fixture mode is not available in this build. No request was made. <a href="./">Continue to GitHub sign-in</a>
        </p>
      </div>
    );
  }
  return <Main mode={mode} />;
}

function Main({ mode }: { mode: Mode }) {
  const env = useMemo(() => createEnvironment(mode, window.location), [mode]);
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const route = parseHash(hash);
  const [connected, setConnected] = useState(() => patProvider.describe().connected);
  const queryClient = useQueryClient();

  function disconnect() {
    patProvider.clear();
    queryClient.clear();
    setConnected(false);
    window.location.hash = "";
  }

  return (
    <div className="app">
      {__FIXTURE_MODE__ && mode === "fixtures" && <FixtureBanner />}
      <header className="topbar">
        <Brand />
        <div className="topbar-actions">
          <ThemeToggle />
          {mode === "live" && connected && <button onClick={disconnect}>Disconnect</button>}
        </div>
      </header>
      <main>
        {mode === "live" && !connected ? (
          <ConnectView onConnected={() => setConnected(true)} />
        ) : route.run ? (
          <RunExplorer key={`${route.run.owner}/${route.run.repo}/${route.run.runId}`} env={env} run={route.run} route={route} />
        ) : route.repo ? (
          <RepoDashboard key={`${route.repo.owner}/${route.repo.repo}/${route.filters?.branch ?? ""}`} env={env} repo={route.repo} filters={route.filters ?? {}} />
        ) : (
          <Home env={env} />
        )}
      </main>
    </div>
  );
}
