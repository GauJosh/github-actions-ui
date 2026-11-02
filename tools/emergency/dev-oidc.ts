// A minimal OpenID Connect provider for local development and tests of emergency-execution sign-in (security review
// H2). NOT for production: it signs in whichever listed user is chosen, without a password. It implements exactly what
// the executor uses: discovery, a JWKS, the authorization endpoint (authorization code with PKCE S256) and the token
// endpoint, with RS256 ID tokens carrying the login's nonce.
//
//   node --disable-warning=ExperimentalWarning tools/emergency/dev-oidc.ts --port 9400 \
//     --client-id gha-emergency --redirect-uri http://localhost:5173/api/emergency/auth/callback --users alice,bob,carol
//
// The executor then needs auth.oidc.issuer http://127.0.0.1:9400 and auth.oidc.allowInsecureHttp: true.
//
// Tests use createDevIdp() in process: its fetch() answers the executor's requests without a network, and tamper()
// makes the next ID token wrong in a chosen way (wrong signer, audience, issuer, nonce, expiry, algorithm, claims).
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type DevUser = { sub: string; name: string; email?: string };
export type Tamper = {
  /** Sign with a key the provider doesn't publish. */
  foreignKey?: boolean;
  /** Header algorithm (e.g. "none", "HS256"); with "none" the signature is empty. */
  alg?: string;
  /** Claims to add or override (e.g. roles, aud, iss, exp, nonce). */
  claims?: Record<string, unknown>;
};

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export function createDevIdp(o: { issuer: string; clientId: string; redirectUri: string; users: DevUser[]; clientSecret?: string; now?: () => Date }) {
  const now = o.now ?? (() => new Date());
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(8).toString("hex");
  const codes = new Map<string, { user: DevUser; nonce: string; challenge: string; redirectUri: string }>();
  let nextTamper: Tamper | undefined;
  const tokenRequests: { body: string; authorization?: string }[] = [];

  function mint(user: DevUser, nonce: string, tamper: Tamper = {}): string {
    const t = Math.floor(now().getTime() / 1000);
    const alg = tamper.alg ?? "RS256";
    const header = b64({ alg, kid, typ: "JWT" });
    const payload = b64({ iss: o.issuer, sub: user.sub, aud: o.clientId, iat: t, exp: t + 300, nonce, name: user.name, email: user.email, ...tamper.claims });
    if (alg === "none") return `${header}.${payload}.`;
    if (alg.startsWith("HS")) return `${header}.${payload}.${createHash("sha256").update(`${header}.${payload}`).digest("base64url")}`;
    const key: KeyObject = tamper.foreignKey ? foreign.privateKey : keyPair.privateKey;
    return `${header}.${payload}.${sign("sha256", Buffer.from(`${header}.${payload}`), key).toString("base64url")}`;
  }

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  /** The provider's endpoints, as a fetch: what the executor's OIDC client calls. */
  async function handle(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    if (!url.startsWith(o.issuer)) return json(404, { error: "not this provider" });
    const path = u.pathname.slice(new URL(o.issuer).pathname.replace(/\/$/, "").length);
    if (path === "/.well-known/openid-configuration") {
      return json(200, { issuer: o.issuer, authorization_endpoint: `${o.issuer}/authorize`, token_endpoint: `${o.issuer}/token`, jwks_uri: `${o.issuer}/jwks`, response_types_supported: ["code"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"] });
    }
    if (path === "/jwks") return json(200, { keys: [{ ...keyPair.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }] });
    if (path === "/authorize") {
      const q = u.searchParams;
      if (q.get("client_id") !== o.clientId || q.get("redirect_uri") !== o.redirectUri || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256") return json(400, { error: "invalid_request" });
      const user = o.users.find((x) => x.sub === q.get("login_hint"));
      if (!user) {
        const links = o.users.map((x) => `<li><a href="${u.pathname}?${new URLSearchParams({ ...Object.fromEntries(q), login_hint: x.sub })}">${x.name}</a></li>`).join("");
        return new Response(`<!doctype html><title>Dev sign-in</title><h1>Development sign-in (no password)</h1><ul>${links}</ul>`, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      const code = randomBytes(16).toString("hex");
      codes.set(code, { user, nonce: q.get("nonce") ?? "", challenge: q.get("code_challenge") ?? "", redirectUri: q.get("redirect_uri")! });
      const back = new URL(o.redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state") ?? "");
      return new Response(null, { status: 302, headers: { Location: back.toString() } });
    }
    if (path === "/token" && init.method === "POST") {
      const body = String(init.body ?? "");
      const headers = new Headers(init.headers);
      tokenRequests.push({ body, authorization: headers.get("authorization") ?? undefined });
      const f = new URLSearchParams(body);
      const c = codes.get(f.get("code") ?? "");
      codes.delete(f.get("code") ?? "");
      if (!c) return json(400, { error: "invalid_grant" });
      if (f.get("client_id") !== o.clientId || f.get("redirect_uri") !== c.redirectUri) return json(400, { error: "invalid_client" });
      if (createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      if (o.clientSecret && headers.get("authorization") !== `Basic ${Buffer.from(`${o.clientId}:${o.clientSecret}`).toString("base64")}`) return json(401, { error: "invalid_client" });
      const tamper = nextTamper;
      nextTamper = undefined;
      return json(200, { access_token: randomBytes(16).toString("hex"), token_type: "Bearer", id_token: mint(c.user, c.nonce, tamper) });
    }
    return json(404, { error: "not found" });
  }

  return {
    fetch: handle,
    mint,
    tokenRequests,
    /** The next ID token is wrong in this way. */
    tamper(t: Tamper) {
      nextTamper = t;
    },
    /** Follows the authorization redirect as the browser would, choosing a user; returns the callback's query. */
    async authorize(authorizationUrl: string, sub: string): Promise<URLSearchParams> {
      const u = new URL(authorizationUrl);
      u.searchParams.set("login_hint", sub);
      const r = await handle(u.toString());
      const location = r.headers.get("location");
      if (r.status !== 302 || !location) throw new Error(`The dev provider refused the authorization request (${r.status})`);
      return new URL(location).searchParams;
    },
  };
}

// ---- command line: a real HTTP provider for local development ------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "9400" }, "client-id": { type: "string", default: "gha-emergency" }, "redirect-uri": { type: "string" }, users: { type: "string", default: "alice,bob,carol" } } });
  if (!values["redirect-uri"]) throw new Error("--redirect-uri is required");
  const issuer = `http://127.0.0.1:${values.port}`;
  const idp = createDevIdp({ issuer, clientId: values["client-id"]!, redirectUri: values["redirect-uri"], users: values.users!.split(",").map((n) => ({ sub: `dev-${n}`, name: n, email: `${n}@example.test` })) });
  createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const r = await idp.fetch(`${issuer}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
  }).listen(Number(values.port), "127.0.0.1", () => console.log(`Development OpenID provider (no passwords; never use outside development) at ${issuer}`));
}
