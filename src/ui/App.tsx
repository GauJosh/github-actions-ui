import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore } from "react";
import { createEnvironment, modeFromLocation, type Environment, type Mode } from "../app/environment";
import { patProvider } from "../auth/pat-provider";
import { parseHash, parseRunUrl, routeToHash } from "../domain/run-url";
import { FixtureBanner, FixtureIndex } from "../fixture-mode/FixtureIndex";
import { ConnectView } from "./ConnectView";
import { RunView } from "./RunView";

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
        <h1>GitHub Actions UI</h1>
        {mode === "live" && connected && <button onClick={disconnect}>Disconnect</button>}
      </header>
      <main>
        {mode === "live" && !connected ? (
          <ConnectView onConnected={() => setConnected(true)} />
        ) : (
          <>
            <RunPicker env={env} />
            {route.run && <RunView env={env} run={route.run} jobId={route.jobId} line={route.line} />}
          </>
        )}
      </main>
    </div>
  );
}

function RunPicker({ env }: { env: Environment }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function open(event: React.FormEvent) {
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
    <section className="panel picker">
      <form onSubmit={open}>
        <label htmlFor="run-url">GitHub Actions run URL</label>
        <input id="run-url" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://github.com/OWNER/REPO/actions/runs/123" />
        <button type="submit">Open run</button>
      </form>
      {error && <p className="state state-error">{error}</p>}
      {__FIXTURE_MODE__ && env.mode === "fixtures" && <FixtureIndex />}
    </section>
  );
}
