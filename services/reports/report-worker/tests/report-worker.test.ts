import { describe, expect, it } from 'vitest';
import { type ReportRequested, type ReportStatus, SUBJECT_REQUESTED, SUBJECT_STATUS } from '../src/events';
import { MAX_ATTEMPTS, createHandler } from '../src/handler';
import { type Email, MemoryMailer, type Mailer } from '../src/mailer';
import { InMemoryQueue } from '../src/queue';
import { buildUsageCsv } from '../src/report';

const request = (over: Partial<ReportRequested> = {}): ReportRequested => ({
  reportId: 'r_1',
  userId: 'user_alice',
  email: 'alice@example.test',
  period: '2026-08',
  crashFirstAttempt: false,
  ...over,
});

async function setup(mailer: Mailer = new MemoryMailer()) {
  const queue = new InMemoryQueue();
  await queue.subscribe(SUBJECT_REQUESTED, 'report-workers', createHandler({ queue, mailer, now: () => new Date(0) }));
  const statuses = () =>
    queue.published.filter((p) => p.subject === SUBJECT_STATUS).map((p) => p.message as ReportStatus);
  return { queue, statuses };
}

describe('buildUsageCsv', () => {
  it('has a header and one row per day, and is deterministic', () => {
    const a = buildUsageCsv('2026-02');
    expect(a.rows).toBe(28);
    expect(a.csv.split('\n')[0]).toBe('date,active_users,api_calls');
    expect(a.csv.trim().split('\n')).toHaveLength(29);
    expect(buildUsageCsv('2026-02')).toEqual(a);
    expect(buildUsageCsv('2026-03')).not.toEqual(a);
  });
});

describe('report-worker', () => {
  it('emails the CSV to the address on the request and reports it sent', async () => {
    const mailer = new MemoryMailer();
    const { queue, statuses } = await setup(mailer);
    await queue.publish(SUBJECT_REQUESTED, request());

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: 'alice@example.test', subject: 'Your usage report for 2026-08' });
    expect(mailer.sent[0].attachment.filename).toBe('usage-2026-08.csv');
    expect(statuses().map((s) => s.status)).toEqual(['processing', 'sent']);
    expect(statuses().at(-1)).toMatchObject({ rows: 31, sentTo: 'alice@example.test', attempt: 1 });
  });

  it('retries after a crash on the first attempt and sends exactly one email', async () => {
    const mailer = new MemoryMailer();
    const { queue, statuses } = await setup(mailer);
    await queue.publish(SUBJECT_REQUESTED, request({ crashFirstAttempt: true }));

    expect(statuses().map((s) => [s.status, s.attempt])).toEqual([
      ['processing', 1],
      ['retrying', 1],
      ['processing', 2],
      ['sent', 2],
    ]);
    expect(mailer.sent).toHaveLength(1);
  });

  it('gives up after MAX_ATTEMPTS and reports the failure', async () => {
    const broken: Mailer = {
      send: async (_: Email) => {
        throw new Error('smtp down');
      },
    };
    const { queue, statuses } = await setup(broken);
    await queue.publish(SUBJECT_REQUESTED, request());

    const last = statuses().at(-1);
    expect(last).toMatchObject({ status: 'failed', attempt: MAX_ATTEMPTS, error: 'smtp down' });
    expect(statuses().filter((s) => s.status === 'retrying')).toHaveLength(MAX_ATTEMPTS - 1);
  });
});
