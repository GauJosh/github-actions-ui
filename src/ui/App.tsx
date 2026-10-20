import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore } from "react";
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

export function App() {
  const mode = modeFromLocation(window.location.search);
  if (mode === "fixtures-unavailable") {
    return (
      <div className="app">
        <header className="topbar">
          <h1>GitHub Actions UI</h1>
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
        <h1>
          <a href="#/">GitHub Actions UI</a>
        </h1>
        {mode === "live" && connected && <button onClick={disconnect}>Disconnect</button>}
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
