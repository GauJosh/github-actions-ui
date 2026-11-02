// Security review H2: the ID-token verifier, the OpenID Connect client against a real HTTP provider, and the sign-in
// configuration. The API-level attacks (forged tokens, roles, sessions, approvals) are in emergency-executor.test.ts.
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseAuthConfig } from "../../deploy/emergency/executor/auth/config.ts";
import { verifyIdToken, selectKey, type Jwk } from "../../deploy/emergency/executor/auth/jwt.ts";
import { createOidcProvider } from "../../deploy/emergency/executor/auth/oidc.ts";
import { createDevIdp } from "../../tools/emergency/dev-oidc.ts";

const NOW = new Date("2026-10-30T12:00:00Z");
const t = Math.floor(NOW.getTime() / 1000);
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const claims = { iss: "https://idp.test", sub: "u1", aud: "app", iat: t, exp: t + 300, nonce: "n" };
const opts = { issuer: "https://idp.test", clientId: "app", nonce: "n", now: NOW };

function token(alg: string, key: Parameters<typeof sign>[2], payload: object = claims, kid = "k1") {
  const input = `${b64({ alg, kid })}.${b64(payload)}`;
  const hash = { RS256: "sha256", PS256: "sha256", ES256: "sha256", ES384: "sha384" }[alg]!;
  return `${input}.${sign(hash, Buffer.from(input), key).toString("base64url")}`;
}

describe("ID token verification", () => {
  it("verifies RS256, PS256 and ES256 tokens with the issuer's matching key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const rsaJwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "k1" } as Jwk;
    const ecJwk = { ...ec.publicKey.export({ format: "jwk" }), kid: "k1" } as Jwk;
    expect(verifyIdToken(token("RS256", rsa.privateKey), rsaJwk, opts).sub).toBe("u1");
    expect(verifyIdToken(token("PS256", { key: rsa.privateKey, padding: 6, saltLength: 32 }), rsaJwk, opts).sub).toBe("u1");
    expect(verifyIdToken(token("ES256", { key: ec.privateKey, dsaEncoding: "ieee-p1363" }), ecJwk, opts).sub).toBe("u1");
    // An EC key for an RSA token, a key restricted to another algorithm or to encryption: refused.
    expect(() => verifyIdToken(token("RS256", rsa.privateKey), ecJwk, opts)).toThrow(/does not match/);
    expect(() => verifyIdToken(token("RS256", rsa.privateKey), { ...rsaJwk, alg: "RS512" }, opts)).toThrow(/does not match/);
    expect(() => verifyIdToken(token("RS256", rsa.privateKey), { ...rsaJwk, use: "enc" }, opts)).toThrow(/does not match/);
    // An algorithm outside the configured list (ES384 is supported but not allowed by default).
    const ec384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
    expect(() => verifyIdToken(token("ES384", { key: ec384.privateKey, dsaEncoding: "ieee-p1363" }), { ...ec384.publicKey.export({ format: "jwk" }), kid: "k1" } as Jwk, opts)).toThrow(/not allowed/);
  });

  it("selects the key by kid among the issuer's signing keys; without a kid only an unambiguous key", () => {
    const keys: Jwk[] = [{ kty: "RSA", kid: "a" }, { kty: "RSA", kid: "b", use: "sig" }, { kty: "RSA", kid: "c", use: "enc" }, { kty: "EC", kid: "d" }];
    expect(selectKey(keys, { alg: "RS256", kid: "b" })?.kid).toBe("b");
    expect(selectKey(keys, { alg: "RS256", kid: "c" })).toBeUndefined();
    expect(selectKey(keys, { alg: "RS256" })).toBeUndefined();
    expect(selectKey([keys[0]!], { alg: "RS256" })?.kid).toBe("a");
  });

  it("refuses malformed tokens and critical headers", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "k1" } as Jwk;
    expect(() => verifyIdToken("a.b", jwk, opts)).toThrow(/not a signed JWT/);
    expect(() => verifyIdToken(`${b64({ alg: "RS256", crit: ["exp"] })}.${b64(claims)}.x`, jwk, opts)).toThrow(/critical/);
    expect(() => verifyIdToken(`${b64({ alg: "RS256" })}.not json.x`, jwk, opts)).toThrow(/base64url|JSON/);
  });
});

describe("OpenID Connect client", () => {
  // Unit tests may not open network connections (tests/setup): the provider's endpoints answer through its fetch.
  it("signs in through discovery, the JWKS and a PKCE code exchange with a client secret", async () => {
    const issuer = "https://idp.example.test/tenant";
    const redirectUri = "https://gha.example.test/api/emergency/auth/callback";
    const idp = createDevIdp({ issuer, clientId: "gha", redirectUri, users: [{ sub: "s-1", name: "Sam" }], clientSecret: "client-secret-value" });
    const provider = createOidcProvider({ issuer, clientId: "gha", redirectUri, clientSecret: () => "client-secret-value" }, { fetch: idp.fetch });
    const { url, pending } = await provider.begin();
    expect(await provider.complete(await idp.authorize(url, "s-1"), pending)).toEqual({ issuer, subject: "s-1", name: "Sam", email: undefined });
    expect(idp.tokenRequests[0]!.authorization).toBe(`Basic ${Buffer.from("gha:client-secret-value").toString("base64")}`);
    // A wrong client secret is refused by the provider, and the sign-in fails.
    const wrong = createOidcProvider({ issuer, clientId: "gha", redirectUri, clientSecret: () => "guessed" }, { fetch: idp.fetch });
    const second = await wrong.begin();
    await expect(wrong.complete(await idp.authorize(second.url, "s-1"), second.pending)).rejects.toThrow(/answered 401/);
    // An HTTP issuer is refused unless explicitly allowed (local development providers only).
    expect(() => createOidcProvider({ issuer: "http://127.0.0.1:9400", clientId: "gha", redirectUri })).toThrow(/not HTTPS/);
    // A discovery document naming another issuer, or HTTP endpoints, are refused.
    const doc = (d: object) => async () => new Response(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, ...d }));
    await expect(createOidcProvider({ issuer, clientId: "gha", redirectUri }, { fetch: doc({ issuer: "https://evil.example" }) }).begin()).rejects.toThrow(/names issuer/);
    await expect(createOidcProvider({ issuer, clientId: "gha", redirectUri }, { fetch: doc({ token_endpoint: "http://idp.example.test/token" }) }).begin()).rejects.toThrow(/token endpoint is not HTTPS/);
  });
});

describe("sign-in configuration", () => {
  const base = { oidc: { issuer: "https://idp.test", clientId: "gha", redirectUri: "https://gha.test/api/emergency/auth/callback" } };
  it("has safe defaults: 8-hour sessions, 1-hour idle, approval for Secrets and egress, separation of duties", () => {
    expect(parseAuthConfig(JSON.stringify(base))).toMatchObject({ sessions: { maxHours: 8, idleMinutes: 60, breakGlassMinutes: 60 }, approval: { requireFor: ["secrets", "egress"], separationOfDuties: true, ttlMinutes: 60 }, breakGlass: { accounts: [] } });
    expect(parseAuthConfig("{}").oidc).toBeNull();
  });
  it("refuses weakening or ambiguous configuration", () => {
    const bad = (v: object) => () => parseAuthConfig(JSON.stringify(v));
    expect(bad({ oidc: { ...base.oidc, issuer: "http://idp.test" } })).toThrow(/must be HTTPS/);
    expect(bad({ oidc: { ...base.oidc, redirectUri: "https://gha.test/elsewhere" } })).toThrow(/auth\/callback/);
    expect(bad({ oidc: { ...base.oidc, scopes: ["profile"] } })).toThrow(/openid/);
    expect(bad({ ...base, breakGlass: { accounts: [{ name: "r1", roles: ["administrator"] }] } })).toThrow(/can't be an administrator/);
    expect(bad({ ...base, breakGlass: { accounts: [{ name: "r1", roles: ["root"] }] } })).toThrow(/needs roles/);
    expect(bad({ ...base, breakGlass: { accounts: [{ name: "r1", roles: [] }, { name: "r1", roles: [] }] } })).toThrow(/unique/);
    expect(bad({ ...base, approval: { requireFor: ["never"] } })).toThrow(/requireFor/);
    expect(bad({ ...base, sessions: { maxHours: 10_000 } })).toThrow(/maxHours/);
    expect(bad({ ...base, initialAdministrators: [{ subject: "x" }] })).toThrow(/issuer and subject/);
    expect(parseAuthConfig(JSON.stringify({ oidc: { ...base.oidc, issuer: "http://127.0.0.1:9400", allowInsecureHttp: true } })).oidc?.allowInsecureHttp).toBe(true);
  });
});
