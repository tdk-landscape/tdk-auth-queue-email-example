import { Hono } from 'hono';
import type { Claims, Verify } from './auth';
import { type ReportRequested, type ReportStatus, SUBJECT_REQUESTED, SUBJECT_STATUS } from './events';
import type { Queue } from './queue';

export interface Report {
  id: string;
  userId: string;
  period: string;
  status: 'queued' | ReportStatus['status'];
  attempts: number;
  crashFirstAttempt: boolean;
  rows?: number;
  sentTo?: string;
  error?: string;
  requestedAt: string;
  updatedAt: string;
}

type Env = { Variables: { user: Claims } };

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function createApp(deps: { verify: Verify; queue: Queue }) {
  const app = new Hono<Env>();
  const reports = new Map<string, Report>();
  let nextId = 1;

  // The Vue app runs on its own origin and calls this API directly.
  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });

  app.get('/health', (c) => c.json({ status: 'ok', service: 'reports-api' }));

  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return c.json({ error: 'missing bearer token' }, 401);
    try {
      c.set('user', await deps.verify(token));
    } catch (error) {
      return c.json({ error: 'invalid token', detail: (error as Error).message }, 401);
    }
    await next();
  });

  app.get('/api/me', (c) => c.json({ data: c.get('user') }));

  app.get('/api/reports', (c) => {
    const { sub } = c.get('user');
    return c.json({ data: [...reports.values()].filter((r) => r.userId === sub).reverse() });
  });

  app.post('/api/reports', async (c) => {
    const user = c.get('user');
    if (!user.email) return c.json({ error: 'your token has no email claim to send the report to' }, 400);

    const body = await c.req.json().catch(() => null);
    const period = typeof body?.period === 'string' ? body.period : '';
    if (!PERIOD.test(period)) return c.json({ error: 'period must look like 2026-08' }, 400);

    const now = new Date().toISOString();
    const report: Report = {
      id: `r_${nextId++}`,
      userId: user.sub,
      period,
      status: 'queued',
      attempts: 0,
      crashFirstAttempt: body?.crashFirstAttempt === true,
      requestedAt: now,
      updatedAt: now,
    };
    reports.set(report.id, report);

    const message: ReportRequested = {
      reportId: report.id,
      userId: user.sub,
      email: user.email,
      period,
      crashFirstAttempt: report.crashFirstAttempt,
    };
    await deps.queue.publish(SUBJECT_REQUESTED, message);
    return c.json({ data: report }, 202);
  });

  // The worker reports progress over the queue; the API never calls it directly.
  await deps.queue.subscribe(SUBJECT_STATUS, 'reports-api-status', async (raw) => {
    const event = raw as ReportStatus;
    const report = reports.get(event.reportId);
    if (!report) return;
    report.status = event.status;
    report.attempts = Math.max(report.attempts, event.attempt);
    report.rows = event.rows ?? report.rows;
    report.sentTo = event.sentTo ?? report.sentTo;
    report.error = event.error;
    report.updatedAt = event.at;
  });

  return app;
}
