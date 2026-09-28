import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { AUDIENCE, ISSUER, app } from '../src/index';

const token = (body: unknown) =>
  app.request('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('auth-emulator', () => {
  it('reports health', async () => {
    expect(await (await app.request('/health')).json()).toEqual({ status: 'ok', service: 'auth-emulator' });
  });

  it('publishes a discovery document that points at its own endpoints', async () => {
    const doc = await (await app.request('/.well-known/openid-configuration')).json();
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
    expect(doc.token_endpoint).toBe(`${ISSUER}/token`);
  });

  it('issues a token that verifies against its own JWKS, with issuer and audience', async () => {
    const res = await token({ grant_type: 'password', username: 'alice', password: 'alice-pass' });
    expect(res.status).toBe(200);
    const { access_token, token_type } = await res.json();
    expect(token_type).toBe('Bearer');

    const jwks = createLocalJWKSet(await (await app.request('/.well-known/jwks.json')).json());
    const { payload } = await jwtVerify(access_token, jwks, { issuer: ISSUER, audience: AUDIENCE });
    expect(payload.sub).toBe('user_alice');
    expect(payload.email).toBe('alice@example.test');
  });

  it('accepts form-encoded requests like a real token endpoint', async () => {
    const res = await app.request('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=password&username=bob&password=bob-pass',
    });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password and unsupported grants', async () => {
    expect((await token({ grant_type: 'password', username: 'alice', password: 'nope' })).status).toBe(401);
    expect((await token({ grant_type: 'client_credentials' })).status).toBe(400);
  });
});
