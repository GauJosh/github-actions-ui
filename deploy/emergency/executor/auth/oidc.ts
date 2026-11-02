// Sign-in through an OpenID Connect provider (security review H2): the authorization code flow with PKCE (S256), state
// and nonce, run by the executor itself. The browser only follows redirects; it never sees the ID token, the client
// secret or the provider's keys. Discovery and the JWKS come from the configured issuer, over HTTPS (plain HTTP only
// when explicitly allowed, for a local development provider). The executor never contacts GitHub; the provider must not
// depend on GitHub either, or sign-in fails during the outage this exists for.
//
// IdentityProvider is the abstraction the rest of the executor uses; OIDC is its only implementation.
import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_ALGORITHMS, selectKey, tokenHeader, TokenError, verifyIdToken, type IdTokenClaims, type Jwk } from "./jwt.ts";

export type VerifiedIdentity = { issuer: string; subject: string; name: string; email?: string };
/** What the executor keeps between sending the browser to the provider and its return (never sent to the browser). */
export type PendingLogin = { state: string; nonce: string; verifier: string };

export interface IdentityProvider {
  readonly kind: string;
  readonly label: string;
  begin(): Promise<{ url: string; pending: PendingLogin }>;
  complete(params: URLSearchParams, pending: PendingLogin): Promise<VerifiedIdentity>;
}

export type OidcConfig = {
  issuer: string;
  clientId: string;
  /** Read when needed (a mounted Secret); absent for a public client (PKCE only). */
  clientSecret?: () => string;
  /** Exactly as registered with the provider; never derived from the request's Host header. */
  redirectUri: string;
  scopes?: string[];
  algorithms?: string[];
  label?: string;
  /** Plain HTTP for the issuer and its endpoints: local development providers only. */
  allowInsecureHttp?: boolean;
  /** Refuse ID tokens older than this (seconds since iat). */
  maxTokenAgeSeconds?: number;
};

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const b64url = (b: Buffer) => b.toString("base64url");

export class LoginError extends Error {}

export function createOidcProvider(config: OidcConfig, deps: { fetch?: Fetch; now?: () => Date } = {}): IdentityProvider {
  const doFetch: Fetch = deps.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" }));
  const now = deps.now ?? (() => new Date());
  const algorithms = config.algorithms ?? DEFAULT_ALGORITHMS;
  let discovery: Discovery | undefined;
  let jwks: { keys: Jwk[]; fetchedAt: number } | undefined;

  const checkUrl = (value: unknown, what: string): string => {
    let u: URL;
    try {
      u = new URL(String(value));
    } catch {
      throw new LoginError(`The identity provider's ${what} is not a URL`);
    }
    if (u.protocol !== "https:" && !(config.allowInsecureHttp && u.protocol === "http:")) throw new LoginError(`The identity provider's ${what} is not HTTPS`);
    return u.toString();
  };
  checkUrl(config.issuer, "issuer");

  async function getJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    let r: Response;
    try {
      r = await doFetch(url, init);
    } catch (error) {
      const cause = (error as Error & { cause?: Error }).cause;
      throw new LoginError(`The identity provider could not be reached (${(error as Error).message}${cause ? `: ${cause.message}` : ""})`);
    }
    const text = await r.text();
    if (!r.ok) throw new LoginError(`The identity provider answered ${r.status} for ${new URL(url).pathname}`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new LoginError(`The identity provider's response from ${new URL(url).pathname} is not JSON`);
    }
  }

  async function discover(): Promise<Discovery> {
    if (discovery) return discovery;
    const d = await getJson(`${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    // OpenID Connect Discovery §4.3: the document must name exactly the configured issuer.
    if (d.issuer !== config.issuer) throw new LoginError(`The identity provider's discovery document names issuer ${JSON.stringify(d.issuer)}, not ${config.issuer}`);
    discovery = { issuer: config.issuer, authorization_endpoint: checkUrl(d.authorization_endpoint, "authorization endpoint"), token_endpoint: checkUrl(d.token_endpoint, "token endpoint"), jwks_uri: checkUrl(d.jwks_uri, "JWKS URI") };
    return discovery;
  }

  async function keys(refresh: boolean): Promise<Jwk[]> {
    // An unknown key ID refreshes the cache, at most once a minute (key rotation without hammering the provider).
    if (jwks && (!refresh || now().getTime() - jwks.fetchedAt < 60_000)) return jwks.keys;
    const d = await discover();
    const set = await getJson(d.jwks_uri);
    if (!Array.isArray(set.keys)) throw new LoginError("The identity provider's JWKS has no keys");
    jwks = { keys: set.keys as Jwk[], fetchedAt: now().getTime() };
    return jwks.keys;
  }

  return {
    kind: "oidc",
    label: config.label ?? "your organization's identity provider",
    async begin() {
      const d = await discover();
      const pending: PendingLogin = { state: b64url(randomBytes(32)), nonce: b64url(randomBytes(32)), verifier: b64url(randomBytes(48)) };
      const url = new URL(d.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("scope", (config.scopes ?? ["openid", "profile", "email"]).join(" "));
      url.searchParams.set("state", pending.state);
      url.searchParams.set("nonce", pending.nonce);
      url.searchParams.set("code_challenge", b64url(createHash("sha256").update(pending.verifier).digest()));
      url.searchParams.set("code_challenge_method", "S256");
      return { url: url.toString(), pending };
    },
    async complete(params, pending) {
      if (params.get("state") !== pending.state) throw new LoginError("The sign-in response does not belong to this sign-in (state)");
      const error = params.get("error");
      if (error) throw new LoginError(`The identity provider refused the sign-in: ${error}${params.get("error_description") ? ` (${params.get("error_description")})` : ""}`);
      const code = params.get("code");
      if (!code) throw new LoginError("The identity provider returned no authorization code");
      const d = await discover();
      const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: pending.verifier, client_id: config.clientId });
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
      const secret = config.clientSecret?.();
      if (secret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`;
      const tokens = await getJson(d.token_endpoint, { method: "POST", headers, body: form.toString() });
      if (typeof tokens.id_token !== "string") throw new LoginError("The identity provider returned no ID token");
      let claims: IdTokenClaims;
      try {
        const header = tokenHeader(tokens.id_token, algorithms);
        const key = selectKey(await keys(false), header) ?? selectKey(await keys(true), header);
        if (!key) throw new TokenError("The ID token is signed with a key the identity provider does not publish");
        claims = verifyIdToken(tokens.id_token, key, { issuer: config.issuer, clientId: config.clientId, nonce: pending.nonce, now: now(), algorithms, maxAgeSeconds: config.maxTokenAgeSeconds ?? 600 });
      } catch (e) {
        if (e instanceof TokenError) throw new LoginError(e.message);
        throw e;
      }
      const name = [claims.name, claims.preferred_username, claims.email].find((v) => typeof v === "string" && v.trim()) ?? claims.sub;
      return { issuer: claims.iss, subject: claims.sub, name: String(name).slice(0, 200), email: typeof claims.email === "string" ? claims.email.slice(0, 254) : undefined };
    },
  };
}
