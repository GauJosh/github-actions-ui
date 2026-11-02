// Verification of OpenID Connect ID tokens (JWS compact serialization, RFC 7515/7519; OpenID Connect Core 1.0 §3.1.3.7),
// with Node's crypto only. Only what an ID token from the configured issuer needs, and nothing more permissive:
// - asymmetric algorithms only (RS256/384/512, PS256/384/512, ES256/384/512), from a configured allow list; never
//   "none" or HMAC (a public key must never be usable as a shared secret);
// - the key is chosen by "kid" from the issuer's JWKS and must match the algorithm's key type (and its "alg" and "use"
//   when the key states them);
// - iss must equal the configured issuer, aud must contain the client ID (and azp must be the client ID when there are
//   several audiences), exp, nbf and iat are checked with a small clock skew, and nonce must match the login's.
// Claims are returned only after all of that. Identity is (iss, sub); nothing else in the token is trusted for
// authorization (roles come from the executor's own records, auth/store.ts).
import { constants, createPublicKey, verify, type JsonWebKeyInput, type KeyObject } from "node:crypto";

export type Jwk = { kty?: string; kid?: string; use?: string; alg?: string; [k: string]: unknown };
export type IdTokenClaims = { iss: string; sub: string; aud: string | string[]; exp: number; iat: number; nonce?: string; azp?: string; name?: string; email?: string; preferred_username?: string; [k: string]: unknown };

export const DEFAULT_ALGORITHMS = ["RS256", "ES256", "PS256"];
const SUPPORTED: Record<string, { kty: string; hash: string; pss?: boolean; ec?: boolean }> = {
  RS256: { kty: "RSA", hash: "sha256" },
  RS384: { kty: "RSA", hash: "sha384" },
  RS512: { kty: "RSA", hash: "sha512" },
  PS256: { kty: "RSA", hash: "sha256", pss: true },
  PS384: { kty: "RSA", hash: "sha384", pss: true },
  PS512: { kty: "RSA", hash: "sha512", pss: true },
  ES256: { kty: "EC", hash: "sha256", ec: true },
  ES384: { kty: "EC", hash: "sha384", ec: true },
  ES512: { kty: "EC", hash: "sha512", ec: true },
};

export class TokenError extends Error {}

const b64url = /^[A-Za-z0-9_-]*$/;
function decodeJson(part: string, what: string): Record<string, unknown> {
  if (!b64url.test(part)) throw new TokenError(`The ID token's ${what} is not base64url`);
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new TokenError(`The ID token's ${what} is not a JSON object`);
  }
}

/** The key a token names, or undefined when the JWKS has none (the caller may refresh the JWKS once and retry). */
export function selectKey(jwks: Jwk[], header: { alg: string; kid?: string }): Jwk | undefined {
  const spec = SUPPORTED[header.alg]!;
  const candidates = jwks.filter((k) => k.kty === spec.kty && (k.use === undefined || k.use === "sig") && (k.alg === undefined || k.alg === header.alg));
  if (header.kid !== undefined) return candidates.find((k) => k.kid === header.kid);
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function tokenHeader(token: string, algorithms: string[]): { alg: string; kid?: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("The ID token is not a signed JWT");
  if (!parts.every((p) => b64url.test(p))) throw new TokenError("The ID token is not base64url");
  const h = decodeJson(parts[0]!, "header");
  if (typeof h.alg !== "string" || !algorithms.includes(h.alg) || !SUPPORTED[h.alg]) throw new TokenError(`The ID token's algorithm ${JSON.stringify(h.alg)} is not allowed`);
  if (h.crit !== undefined) throw new TokenError("The ID token has critical header parameters this verifier does not support");
  if (h.kid !== undefined && typeof h.kid !== "string") throw new TokenError("The ID token's kid is not a string");
  return { alg: h.alg, kid: h.kid as string | undefined };
}

export type VerifyOptions = { issuer: string; clientId: string; nonce: string; now: Date; algorithms?: string[]; clockSkewSeconds?: number; maxAgeSeconds?: number };

export function verifyIdToken(token: string, key: Jwk, o: VerifyOptions): IdTokenClaims {
  const algorithms = o.algorithms ?? DEFAULT_ALGORITHMS;
  const header = tokenHeader(token, algorithms);
  const spec = SUPPORTED[header.alg]!;
  if (key.kty !== spec.kty || (key.alg !== undefined && key.alg !== header.alg) || (key.use !== undefined && key.use !== "sig")) throw new TokenError("The signing key does not match the token's algorithm");
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key, format: "jwk" } as JsonWebKeyInput);
  } catch {
    throw new TokenError("The issuer's signing key is not a valid public key");
  }
  if (publicKey.type !== "public") throw new TokenError("The issuer's signing key is not a public key");
  const [h, p, s] = token.split(".") as [string, string, string];
  if (!b64url.test(s)) throw new TokenError("The ID token's signature is not base64url");
  const ok = verify(spec.hash, Buffer.from(`${h}.${p}`), { key: publicKey, ...(spec.pss ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : {}), ...(spec.ec ? { dsaEncoding: "ieee-p1363" } : {}) }, Buffer.from(s, "base64url"));
  if (!ok) throw new TokenError("The ID token's signature is not valid");

  const c = decodeJson(p, "payload");
  const skew = o.clockSkewSeconds ?? 60;
  const now = Math.floor(o.now.getTime() / 1000);
  if (c.iss !== o.issuer) throw new TokenError(`The ID token was issued by ${JSON.stringify(c.iss)}, not ${o.issuer}`);
  const aud = typeof c.aud === "string" ? [c.aud] : Array.isArray(c.aud) && c.aud.every((a) => typeof a === "string") ? (c.aud as string[]) : [];
  if (!aud.includes(o.clientId)) throw new TokenError("The ID token is not for this application (audience)");
  if ((aud.length > 1 || c.azp !== undefined) && c.azp !== o.clientId) throw new TokenError("The ID token's authorized party is not this application");
  if (typeof c.sub !== "string" || !c.sub || c.sub.length > 255) throw new TokenError("The ID token has no valid subject");
  if (typeof c.exp !== "number" || c.exp + skew <= now) throw new TokenError("The ID token has expired");
  if (typeof c.iat !== "number" || c.iat - skew > now) throw new TokenError("The ID token was issued in the future");
  if (o.maxAgeSeconds !== undefined && now - c.iat > o.maxAgeSeconds + skew) throw new TokenError("The ID token is too old");
  if (c.nbf !== undefined && (typeof c.nbf !== "number" || c.nbf - skew > now)) throw new TokenError("The ID token is not valid yet");
  if (c.nonce !== o.nonce) throw new TokenError("The ID token's nonce does not match this sign-in");
  return c as IdTokenClaims;
}
