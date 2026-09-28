import { createHandler } from './handler';
import { SmtpMailer } from './mailer';
import { NatsQueue } from './nats-queue';
import { SUBJECT_REQUESTED } from './events';

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see params in service.json)`);
  return value;
};

// TILT_NATS_URL is injected by TDK for every backend and worker.
const queue = await NatsQueue.connect(process.env.NATS_URL || need('TILT_NATS_URL'), {
  retryDelayMs: Number(process.env.RETRY_DELAY_MS || 3000),
});
const mailer = new SmtpMailer(need('SMTP_HOST'), Number(need('SMTP_PORT')), need('MAIL_FROM'));

// One shared durable name: run several replicas and they split the work.
await queue.subscribe(SUBJECT_REQUESTED, 'report-workers', createHandler({ queue, mailer }));
console.log(`\n📨 report-worker consuming ${SUBJECT_REQUESTED}`);
