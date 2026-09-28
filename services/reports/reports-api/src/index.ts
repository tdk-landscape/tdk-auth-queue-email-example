import { createApp } from './app';
import { createVerifier } from './auth';
import { NatsQueue } from './nats-queue';

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see params in service.json)`);
  return value;
};

// TILT_NATS_URL is injected by TDK for every backend.
const queue = await NatsQueue.connect(process.env.NATS_URL || need('TILT_NATS_URL'));

const app = await createApp({
  verify: createVerifier({
    issuer: need('OIDC_ISSUER'),
    jwksUrl: need('OIDC_JWKS_URL'),
    audience: need('OIDC_AUDIENCE'),
  }),
  queue,
});

const port = process.env.PORT || 3000;
console.log(`\n🚀 reports-api running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
