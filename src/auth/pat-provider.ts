// The personal access token lives only in this module-scoped variable: never in React state,
// storage, URLs, the worker, or diagnostics. A reload or "Disconnect" discards it.

export interface AuthProvider {
  /** Adds the Authorization header. The only place the token is read. */
  authorize(headers: Headers): void;
  describe(): { kind: "pat"; connected: boolean };
  clear(): void;
}

let token: string | null = null;

export const patProvider: AuthProvider & { connect(value: string): void } = {
  connect(value) {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Enter a token");
    token = trimmed;
  },
  authorize(headers) {
    if (token) headers.set("Authorization", `Bearer ${token}`);
  },
  describe() {
    return { kind: "pat", connected: token !== null };
  },
  clear() {
    token = null;
  },
};
