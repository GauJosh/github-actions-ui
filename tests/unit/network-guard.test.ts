// Proves unmocked requests are rejected before any connection is made: hostnames, raw IPs, loopback,
// with proxy variables set, and through every Node client API.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { HttpResponse, http as mswHttp } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NetworkBlockedError } from "./network-guard";

// A local listener counts connection attempts: anything that got past the guard would show up here.
let server: net.Server;
let port = 0;
let connections = 0;
beforeAll(async () => {
  server = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Resolves with the blocking error whether it is thrown synchronously, emitted as an event, or a fetch rejection. */
async function blockedBy(attempt: () => unknown): Promise<unknown> {
  try {
    const result = attempt();
    if (result instanceof Promise) return await result.then(() => "connected", (e: unknown) => e);
    if (result && typeof (result as NodeJS.EventEmitter).once === "function") {
      return await new Promise((resolve) => (result as NodeJS.EventEmitter).once("error", resolve));
    }
    return "no error";
  } catch (error) {
    return error;
  }
}

/** True when the failure (or anything in its cause chain, which MSW and undici may re-wrap) is the guard's error. */
function isBlocked(e: unknown): boolean {
  for (let current = e, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    if (current instanceof NetworkBlockedError || current.message.startsWith("Blocked unexpected network access in tests")) return true;
  }
  return false;
}

describe("network guard", () => {
  it("rejects fetch to a hostname, a raw IP address and loopback before connecting", async () => {
    for (const url of ["https://api.github.com/repos/o/r", "http://203.0.113.10/", `http://127.0.0.1:${port}/`]) {
      expect(isBlocked(await blockedBy(() => fetch(url)))).toBe(true);
    }
    expect(connections).toBe(0);
  });

  it("is not bypassed by proxy environment variables", async () => {
    const saved = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY };
    process.env.HTTP_PROXY = process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
    try {
      expect(isBlocked(await blockedBy(() => fetch("http://198.51.100.7/")))).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(connections).toBe(0);
  });

  it("blocks http/https requests, raw TCP and TLS sockets, and WebSocket", async () => {
    const attempts: (() => unknown)[] = [
      () => http.get(`http://127.0.0.1:${port}/`),
      () => https.get("https://203.0.113.10/"),
      () => net.connect({ host: "127.0.0.1", port }),
      () => new net.Socket().connect({ host: "203.0.113.10", port: 443 }),
      () => tls.connect({ host: "203.0.113.10", port: 443 }),
    ];
    for (const attempt of attempts) expect(isBlocked(await blockedBy(attempt))).toBe(true);
    expect(connections).toBe(0);
  });

  it("blocks WebSocket connections (they fail without reaching the listener)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise((resolve) => ws.addEventListener("error", resolve));
    expect(connections).toBe(0);
  });

  it("sits beneath MSW: a request MSW passes through is still blocked", async () => {
    const passthrough = setupServer(mswHttp.get("https://mocked.example.test/ok", () => HttpResponse.json({ ok: true })));
    passthrough.listen({ onUnhandledFrame: "bypass" });
    try {
      expect(await (await fetch("https://mocked.example.test/ok")).json()).toEqual({ ok: true });
      // MSW re-wraps the guard's socket error ("fetch failed" / "closed"), so assert on the outcome instead:
      // the request is rejected, and the live local listener below never sees a connection.
      expect(await blockedBy(() => fetch(`http://127.0.0.1:${port}/unmocked`))).toBeInstanceOf(TypeError);
      expect(await blockedBy(() => fetch("http://203.0.113.10/unmocked"))).toBeInstanceOf(TypeError);
    } finally {
      passthrough.close();
    }
    expect(connections).toBe(0);
  });

  it("reports host and port only, never a URL", async () => {
    const error = (await blockedBy(() => fetch("https://productionresultssa1.blob.core.windows.net/x?sig=SECRET"))) as Error;
    const message = String((error.cause as Error | undefined)?.message ?? error.message);
    expect(message).toContain("productionresultssa1.blob.core.windows.net");
    expect(message).not.toContain("sig=");
  });

  it("still allows local IPC pipes (not network access)", () => {
    const socket = new net.Socket();
    expect(() => socket.connect({ path: "\\\\.\\pipe\\gha-ui-test-nonexistent" }).on("error", () => {})).not.toThrow();
    socket.destroy();
  });
});
