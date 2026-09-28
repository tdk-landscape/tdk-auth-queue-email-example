import { AckPolicy, type NatsConnection, StringCodec, connect } from 'nats';
import type { Delivery, Queue } from './queue';

const STREAM = 'REPORTS';
const sc = StringCodec();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Queue on NATS JetStream: durable, at-least-once, replays what was missed while down. */
export class NatsQueue implements Queue {
  private constructor(
    private readonly nc: NatsConnection,
    private readonly retryDelayMs: number,
  ) {}

  /** Retries, because the broker may still be booting when this container starts. */
  static async connect(url: string, options: { retryDelayMs?: number; attempts?: number } = {}): Promise<NatsQueue> {
    const attempts = options.attempts ?? 30;
    for (let attempt = 1; ; attempt++) {
      try {
        const nc = await connect({ servers: url, maxReconnectAttempts: -1 });
        const jsm = await nc.jetstreamManager();
        try {
          await jsm.streams.info(STREAM);
        } catch {
          await jsm.streams.add({ name: STREAM, subjects: ['reports.>'] });
        }
        return new NatsQueue(nc, options.retryDelayMs ?? 3000);
      } catch (error) {
        if (attempt >= attempts) throw error;
        console.log(`[queue] waiting for NATS at ${url} (attempt ${attempt}/${attempts})`);
        await sleep(2000);
      }
    }
  }

  async publish(subject: string, message: unknown): Promise<void> {
    await this.nc.jetstream().publish(subject, sc.encode(JSON.stringify(message)));
  }

  async subscribe(
    subject: string,
    durable: string,
    handler: (message: unknown, delivery: Delivery) => Promise<void>,
  ): Promise<void> {
    const jsm = await this.nc.jetstreamManager();
    try {
      await jsm.consumers.info(STREAM, durable);
    } catch {
      await jsm.consumers.add(STREAM, {
        durable_name: durable,
        filter_subject: subject,
        ack_policy: AckPolicy.Explicit,
      });
    }
    const consumer = await this.nc.jetstream().consumers.get(STREAM, durable);
    const messages = await consumer.consume();
    void (async () => {
      for await (const m of messages) {
        try {
          await handler(JSON.parse(sc.decode(m.data)), { attempt: m.info.deliveryCount });
          m.ack();
        } catch (error) {
          console.error(`[queue] ${subject} attempt ${m.info.deliveryCount} failed, redelivering:`, (error as Error).message);
          m.nak(this.retryDelayMs);
        }
      }
    })();
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}
