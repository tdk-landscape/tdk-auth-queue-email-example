import type { ReportRequested, ReportStatus } from './events';
import { SUBJECT_STATUS } from './events';
import type { Mailer } from './mailer';
import type { Delivery, Queue } from './queue';
import { buildUsageCsv } from './report';

/** After this many attempts the job is reported as failed and acknowledged, not retried forever. */
export const MAX_ATTEMPTS = 3;

export function createHandler(deps: { queue: Queue; mailer: Mailer; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const status = (message: ReportRequested, attempt: number, rest: Partial<ReportStatus> & Pick<ReportStatus, 'status'>) =>
    deps.queue.publish(SUBJECT_STATUS, {
      reportId: message.reportId,
      attempt,
      at: now().toISOString(),
      ...rest,
    } satisfies ReportStatus);

  return async function handle(raw: unknown, { attempt }: Delivery): Promise<void> {
    const message = raw as ReportRequested;
    await status(message, attempt, { status: 'processing' });

    try {
      if (message.crashFirstAttempt && attempt === 1) throw new Error('simulated crash on the first attempt');

      const { csv, rows } = buildUsageCsv(message.period);
      await deps.mailer.send({
        to: message.email,
        subject: `Your usage report for ${message.period}`,
        text: `Hi,\n\nyour usage report for ${message.period} is attached (${rows} rows).\n`,
        attachment: { filename: `usage-${message.period}.csv`, content: csv },
      });
      await status(message, attempt, { status: 'sent', rows, sentTo: message.email });
    } catch (error) {
      const reason = (error as Error).message;
      if (attempt >= MAX_ATTEMPTS) {
        await status(message, attempt, { status: 'failed', error: reason });
        return; // acknowledge: retrying forever would just hide the problem
      }
      await status(message, attempt, { status: 'retrying', error: reason });
      throw error; // not acknowledged: the queue redelivers it
    }
  };
}
