import { useRef, useState } from "react";
import { patProvider } from "../auth/pat-provider";

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

  return (
    <section className="panel connect">
      <h2>Connect to GitHub</h2>
      <form onSubmit={submit} autoComplete="off">
        <label htmlFor="token">Fine-grained personal access token (read-only)</label>
        <input id="token" ref={input} type="password" autoComplete="off" spellCheck={false} data-testid="token-input" />
        <button type="submit">Connect</button>
      </form>
      {error && <p className="state state-error">{error}</p>}
      <ul className="note">
        <li>The token is kept in memory only. Reloading the page or choosing Disconnect forgets it.</li>
        <li>
          Suggested permissions (provisional): <b>Actions: Read</b>, <b>Contents: Read</b>, <b>Metadata: Read</b>.
        </li>
        <li>This app only reads. It never re-runs, cancels or changes anything on GitHub.</li>
      </ul>
      {__FIXTURE_MODE__ && (
        <p>
          <a href="?mode=fixtures">Or explore with demo data (fixture mode, no token)</a>
        </p>
      )}
    </section>
  );
}
