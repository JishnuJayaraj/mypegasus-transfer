import { loginNameOf } from "@transfer/domain";
import * as client from "openid-client";
import type { OidcEnv } from "./env";

// Staff login against Entra ID (ADR-0007; Slice 3 plan D1, D5): the authorization code flow with
// PKCE, `state` and `nonce`, through openid-client. No adapter (ADR-0006): OIDC is a standard,
// not a vendor. MFA is the identity provider's (Conditional Access); `amr` isn't checked.

/** What the callback checks, kept in the signed `tp_oidc` cookie between the two requests. */
export interface OidcChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** The authenticated identity and the name a first login is matched by (D5). */
export interface OidcIdentity {
  issuer: string;
  subject: string;
  loginName: ReturnType<typeof loginNameOf>;
}

export interface Oidc {
  /** A new authorization request: the identity provider's URL and its checks. */
  authorize(): Promise<{ url: string; checks: OidcChecks }>;
  /** Redeems the callback's query (`?code=…&state=…`); throws on any failed check. */
  callback(query: string, checks: OidcChecks): Promise<OidcIdentity>;
}

/**
 * The client. Discovery runs at the first login and is cached; a failed discovery is retried at
 * the next one, so the API starts while the identity provider is unreachable. `fetch` lets tests
 * answer with a local test issuer.
 */
export function createOidc(env: OidcEnv, options: { fetch?: typeof fetch } = {}): Oidc {
  let configuration: Promise<client.Configuration> | undefined;
  const configure = () => {
    configuration ??= client
      .discovery(
        new URL(env.issuer),
        env.clientId,
        undefined,
        client.ClientSecretPost(env.clientSecret),
        options.fetch ? { [client.customFetch]: options.fetch as client.CustomFetch } : undefined,
      )
      .catch((error: unknown) => {
        configuration = undefined;
        throw error;
      });
    return configuration;
  };

  return {
    async authorize() {
      const config = await configure();
      const checks = {
        state: client.randomState(),
        nonce: client.randomNonce(),
        codeVerifier: client.randomPKCECodeVerifier(),
      };
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: env.redirectUrl,
        scope: "openid profile email",
        response_type: "code",
        state: checks.state,
        nonce: checks.nonce,
        code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
        code_challenge_method: "S256",
      });
      return { url: url.href, checks };
    },

    async callback(query, checks) {
      const config = await configure();
      // The redirect URL as configured, never the request's Host header.
      const currentUrl = new URL(env.redirectUrl);
      currentUrl.search = query;
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        pkceCodeVerifier: checks.codeVerifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims()!;
      return { issuer: claims.iss, subject: claims.sub, loginName: loginNameOf(claims) };
    },
  };
}
