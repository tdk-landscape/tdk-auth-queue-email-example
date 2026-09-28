import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface Claims {
  sub: string;
  name?: string;
  email?: string;
}

export type Verify = (token: string) => Promise<Claims>;

export interface OidcConfig {
  /** Expected `iss`. Must match what the provider puts in its tokens. */
  issuer: string;
  /** Where to fetch signing keys. May be an internal URL, unlike the issuer. */
  jwksUrl: string;
  audience: string;
}

/**
 * Verifies a bearer token the way you would against Auth0, Cognito or Entra ID:
 * signature from the JWKS, plus issuer and audience. Nothing here is emulator-specific.
 */
export function createVerifier(config: OidcConfig): Verify {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, { issuer: config.issuer, audience: config.audience });
    if (!payload.sub) throw new Error('token has no subject');
    return { sub: payload.sub, name: payload.name as string | undefined, email: payload.email as string | undefined };
  };
}
