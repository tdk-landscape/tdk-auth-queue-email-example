import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Verify } from '../src/auth';
import { type ReportRequested, type ReportStatus, SUBJECT_REQUESTED, SUBJECT_STATUS } from '../src/events';
import { InMemoryQueue } from '../src/queue';

// Tokens are "<sub>". The real verifier (JWKS, issuer, audience) is exercised against
// the running auth-emulator, see "Check it works" in the README.
const verify: Verify = async (token) => {
  if (token === 'nope') throw new Error('bad token');
  return { sub: token, email: token === 'noemail' ? undefined : `${token}@example.test` };
};

async function setup() {
  const queue = new InMemoryQueue();
  const app = await createApp({ verify, queue });
  const as = (sub: string) => ({ Authorization: `Bearer ${sub}`, 'Content-Type': 'application/json' });
  const request = (sub: string, body: unknown) =>
    app.request('/api/reports', { method: 'POST', headers: as(sub), body: JSON.stringify(body) });
  return { app, queue, as, request };
}

describe('reports-api', () => {
  it('reports health without a token', async () => {
    const { app } = await setup();
    expect(await (await app.request('/health')).json()).toEqual({ status: 'ok', service: 'reports-api' });
  });

  it('rejects requests without a valid token', async () => {
    const { app } = await setup();
    expect((await app.request('/api/reports')).status).toBe(401);
    expect((await app.request('/api/reports', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('queues a report and hands the worker the email from the token', async () => {
    const { queue, request } = await setup();
    const res = await request('alice', { period: '2026-08' });
    expect(res.status).toBe(202);
    const { data } = await res.json();
    expect(data).toMatchObject({ userId: 'alice', period: '2026-08', status: 'queued', attempts: 0 });

    const message: ReportRequested = {
      reportId: data.id,
      userId: 'alice',
      email: 'alice@example.test',
      period: '2026-08',
      crashFirstAttempt: false,
    };
    expect(queue.published).toEqual([{ subject: SUBJECT_REQUESTED, message }]);
  });

  it('validates the period and needs an email claim', async () => {
    const { request } = await setup();
    for (const period of ['', '2026-13', 'August', undefined]) {
      expect((await request('alice', { period })).status).toBe(400);
    }
    expect((await request('noemail', { period: '2026-08' })).status).toBe(400);
  });

  it('follows the status events the worker publishes', async () => {
    const { app, queue, as, request } = await setup();
    const { data } = await (await request('alice', { period: '2026-08' })).json();
    const at = '2026-09-01T00:00:00.000Z';

    const event = (e: Partial<ReportStatus>) =>
      queue.publish(SUBJECT_STATUS, { reportId: data.id, attempt: 1, at, ...e });
    await event({ status: 'retrying', error: 'boom' });
    await event({ status: 'sent', attempt: 2, rows: 30, sentTo: 'alice@example.test', error: undefined });

    const [report] = (await (await app.request('/api/reports', { headers: as('alice') })).json()).data;
    expect(report).toMatchObject({ status: 'sent', attempts: 2, rows: 30, sentTo: 'alice@example.test' });
    expect(report.error).toBeUndefined();
  });

  it("only lists the caller's own reports", async () => {
    const { app, as, request } = await setup();
    await request('alice', { period: '2026-08' });
    expect((await (await app.request('/api/reports', { headers: as('bob') })).json()).data).toEqual([]);
  });
});
