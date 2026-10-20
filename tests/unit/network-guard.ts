// Vitest setup (every test file): unexpected network access fails before any connection is attempted.
//
// The guard sits on net.Socket.prototype.connect: every outbound TCP or TLS connection in Node (global
// fetch, http/https, net/tls.connect, WebSocket) goes through it. It does not filter by hostname, so raw IP
// addresses and proxy settings cannot bypass it.
//
// MSW 3 intercepts at the same layer and installs its patch over this guard on `server.listen()`. For a
// mocked request it connects its socket with its own `mockLookup` (resolves to loopback without DNS and
// never opens a real connection); that one case is allowed. Everything else is blocked, including MSW
// passthrough connections for unhandled requests, which MSW also rejects (`onUnhandledFrame: "error"`).
// If MSW changes these internals, mocked tests fail loudly instead of reaching the network.
import net from "node:net";

export class NetworkBlockedError extends Error {
  constructor(what: string) {
    super(`Blocked unexpected network access in tests (${what}). Mock it with MSW or an injected fake.`);
    this.name = "NetworkBlockedError";
  }
}

type ConnectOptions = { host?: unknown; servername?: unknown; port?: unknown; path?: unknown; lookup?: unknown };

function options(args: unknown[]): ConnectOptions | string | number | undefined {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  return first as ConnectOptions | string | number | undefined;
}

/** Host and port only: never echo a URL, which could carry a signature. */
function describeTarget(o: ReturnType<typeof options>): string {
  if (typeof o === "number") return `port ${o}`;
  if (o && typeof o === "object") return `${String(o.servername ?? o.host ?? "localhost")}:${String(o.port ?? "?")}`;
  return "unknown target";
}

/** Local IPC pipes (a path, no port) are not network access. */
const isPipe = (o: ReturnType<typeof options>) => typeof o === "string" || (!!o && typeof o === "object" && "path" in o && o.path !== undefined && !("port" in o));

/** MSW's in-process connection for a mocked request: a socket it controls, connected with its fake lookup. */
function isMswMockConnection(socket: net.Socket, o: ReturnType<typeof options>): boolean {
  const controlled = Object.getOwnPropertySymbols(socket).some((s) => s.description === "kPatched" && (socket as unknown as Record<symbol, unknown>)[s] === true);
  return controlled && !!o && typeof o === "object" && typeof o.lookup === "function" && o.lookup.name === "mockLookup";
}

const originalConnect = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const o = options(args);
  if (isPipe(o) || isMswMockConnection(this, o)) return originalConnect.apply(this, args);
  // Never connect. Fail the socket the way a refused connection would, so every client (fetch, http,
  // MSW's passthrough) rejects promptly with this error instead of hanging.
  const error = new NetworkBlockedError(`connection to ${describeTarget(o)}`);
  process.nextTick(() => this.destroy(error));
  return this;
} as typeof net.Socket.prototype.connect;
