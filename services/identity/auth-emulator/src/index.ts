import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

/**
 * Local stand-in for a managed identity provider (Auth0, Cognito, Entra ID).
 *
 * It speaks the same OIDC surface a resource server needs: a discovery document,
 * a JWKS endpoint and a token endpoint that signs RS256 JWTs. reports-api only
 * knows an issuer, a JWKS URL and an audience, so pointing it at the real provider
 * is a params change in service.json, not a code change.
 *
 * NOT a security product: users are hard-coded, the password grant is used only
 * because it is the shortest path to a token, and the signing key is regenerated
 * on every start (so tokens die when the container restarts).
 */
export interface DevUser {
  sub: string;
  username: string;
  password: string;
  name: string;
  email: string;
}

export const USERS: DevUser[] = [
  { sub: 'user_alice', username: 'alice', password: 'alice-pass', name: 'Alice Rivera', email: 'alice@example.test' },
  { sub: 'user_bob', username: 'bob', password: 'bob-pass', name: 'Bob Chen', email: 'bob@example.test' },
];

const port = Number(process.env.PORT || 4000);
export const ISSUER = (process.env.OIDC_PUBLIC_ISSUER || `http://localhost:${port}`).replace(/\/$/, '');
export const AUDIENCE = process.env.OIDC_AUDIENCE || 'reports-api';
const TOKEN_TTL_SECONDS = 3600;
const KID = 'dev-key-1';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

export const app = new Hono();

// The Vue app runs on its own origin and posts to /token from the browser.
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

app.get('/health', (c) => c.json({ status: 'ok', service: 'auth-emulator' }));

app.get('/.well-known/openid-configuration', (c) =>
  c.json({
    issuer: ISSUER,
    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    token_endpoint: `${ISSUER}/token`,
    grant_types_supported: ['password'],
    id_token_signing_alg_values_supported: ['RS256'],
    subject_types_supported: ['public'],
  }),
);

app.get('/.well-known/jwks.json', (c) => c.json({ keys: [jwk] }));

app.post('/token', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  const body: Record<string, unknown> = contentType.includes('application/json')
    ? await c.req.json().catch(() => ({}))
    : Object.fromEntries(new URLSearchParams(await c.req.text()));

  if (body.grant_type !== 'password') {
    return c.json({ error: 'unsupported_grant_type' }, 400);
  }
  const user = USERS.find((u) => u.username === body.username && u.password === body.password);
  if (!user) return c.json({ error: 'invalid_grant', error_description: 'wrong username or password' }, 401);

  const accessToken = await new SignJWT({ name: user.name, email: user.email })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(user.sub)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);

  return c.json({ access_token: accessToken, token_type: 'Bearer', expires_in: TOKEN_TTL_SECONDS });
});

console.log(`\n🔐 auth-emulator issuing tokens for ${ISSUER} (audience "${AUDIENCE}")`);

export default {
  port,
  fetch: app.fetch,
};
