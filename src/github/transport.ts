// The only code that calls fetch for GitHub data. Read-only by construction: GET and HEAD only.
import { hostOf } from "../auth/redact";
import type { AuthProvider } from "../auth/pat-provider";

export type ReadMethod = "GET" | "HEAD";
export type TransportRequest = { method: ReadMethod; url: string; headers?: Record<string, string>; signal?: AbortSignal };
/** `finalHost` is the host that produced the response after redirects; the full URL is never kept. */
export type TransportResponse = { response: Response; finalHost: string };
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export class ReadOnlyViolation extends Error {}
export class FixtureModeViolation extends Error {}

export function assertReadOnly(method: string): asserts method is ReadMethod {
  if (method !== "GET" && method !== "HEAD") throw new ReadOnlyViolation(`Blocked non-read request method ${method}`);
}

export const GITHUB_API = "https://api.github.com";

/** Live GitHub. The token is attached only to requests for the API host; redirects are followed by the browser. */
export function createLiveTransport(auth: AuthProvider, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Transport {
  const apiHost = new URL(GITHUB_API).host;
  return async ({ method, url, headers, signal }) => {
    assertReadOnly(method);
    const target = new URL(url);
    if (target.protocol !== "https:" || target.host !== apiHost) {
      throw new ReadOnlyViolation("Blocked a request outside the GitHub API");
    }
    const h = new Headers(headers);
    auth.authorize(h);
    const response = await fetchImpl(target.href, {
      method,
      headers: h,
      signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
    });
    return { response, finalHost: hostOf(response.url) };
  };
}

/** Fixture mode: only the local fixture server is reachable. There is no fallback to live GitHub and no token. */
export function createFixtureTransport(base: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Transport {
  const origin = new URL(base).origin;
  return async ({ method, url, headers, signal }) => {
    assertReadOnly(method);
    if (!url.startsWith(base + "/") || new URL(url).origin !== origin) {
      throw new FixtureModeViolation("Fixture mode blocked a request outside the fixture server");
    }
    const response = await fetchImpl(url, { method, headers, signal, cache: "no-store", credentials: "omit", redirect: "error" });
    return { response, finalHost: hostOf(response.url) };
  };
}
