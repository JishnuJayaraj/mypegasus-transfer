import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHash, randomBytes } from "node:crypto";

// A local OpenID provider for the tests (Slice 3 plan, PR 3b): discovery, JWKS and the token
// endpoint, answered in-process through openid-client's custom fetch. Never a real identity
// provider. Its authorization endpoint is `authorize()`: the user "signs in" as given claims.

export const testIssuer = "https://issuer.test/tenant/v2.0";
export const testClient = { clientId: "transfer-web", clientSecret: "test-client-secret" };

export type TestClaims = { sub: string; email?: string; preferred_username?: string };

type Grant = {
  claims: TestClaims;
  nonce: string | undefined;
  codeChallenge: string | undefined;
  redirectUri: string;
};

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export async function createTestIssuer() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const grants = new Map<string, Grant>();
  const tokenRequests: URLSearchParams[] = [];
  const base = new URL(testIssuer).pathname;

  const app = new Hono();
  app.get(`${base}/.well-known/openid-configuration`, (c) =>
    c.json({
      issuer: testIssuer,
      authorization_endpoint: `${testIssuer}/authorize`,
      token_endpoint: `${testIssuer}/token`,
      jwks_uri: `${testIssuer}/keys`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    }),
  );
  app.get(`${base}/keys`, (c) => c.json({ keys: [jwk] }));
  app.post(`${base}/token`, async (c) => {
    const form = new URLSearchParams(await c.req.text());
    tokenRequests.push(form);
    const grant = grants.get(form.get("code") ?? "");
    grants.delete(form.get("code") ?? "");
    const verifier = form.get("code_verifier");
    if (
      !grant ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("client_id") !== testClient.clientId ||
      form.get("client_secret") !== testClient.clientSecret ||
      form.get("redirect_uri") !== grant.redirectUri ||
      !verifier ||
      s256(verifier) !== grant.codeChallenge
    ) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    const idToken = await new SignJWT({ ...grant.claims, nonce: grant.nonce })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(testIssuer)
      .setAudience(testClient.clientId)
      .setSubject(grant.claims.sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return c.json({
      access_token: "test-access",
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken,
    });
  });

  return {
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      app.fetch(new Request(input, init))) as typeof fetch,
    /** The token requests the client sent (to check PKCE and the client authentication). */
    tokenRequests,
    /**
     * The authorization endpoint: the user authenticates as `claims`; returns the callback's
     * query. `tamper` replaces what the provider echoes, to fail the client's checks.
     */
    authorize(
      authorizationUrl: string,
      claims: TestClaims,
      tamper: { state?: string; nonce?: string; codeChallenge?: string } = {},
    ) {
      const url = new URL(authorizationUrl);
      const code = randomBytes(16).toString("base64url");
      grants.set(code, {
        claims,
        nonce: tamper.nonce ?? url.searchParams.get("nonce") ?? undefined,
        codeChallenge: tamper.codeChallenge ?? url.searchParams.get("code_challenge") ?? undefined,
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
      });
      const state = tamper.state ?? url.searchParams.get("state") ?? "";
      return `?${new URLSearchParams({ code, state })}`;
    },
  };
}
