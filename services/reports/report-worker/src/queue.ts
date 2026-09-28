/**
 * The only thing the app knows about "the queue". A managed queue (SQS, Pub/Sub,
 * Service Bus) gets a second implementation of this interface; nothing else changes.
 */
export interface Delivery {
  /** 1 on the first delivery, 2 after one redelivery, and so on. */
  attempt: number;
}

export interface Queue {
  publish(subject: string, message: unknown): Promise<void>;
  /**
   * At-least-once delivery. Resolve to acknowledge; throw to have the message
   * redelivered after a delay. Consumers with the same `durable` name share the work.
   */
  subscribe(
    subject: string,
    durable: string,
    handler: (message: unknown, delivery: Delivery) => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}

/** Test double: delivers synchronously and redelivers on failure, no broker and no delay. */
export class InMemoryQueue implements Queue {
  readonly published: Array<{ subject: string; message: unknown }> = [];
  private readonly handlers = new Map<string, Array<(message: unknown, delivery: Delivery) => Promise<void>>>();

  constructor(private readonly maxDeliveries = 5) {}

  async publish(subject: string, message: unknown): Promise<void> {
    this.published.push({ subject, message });
    for (const handler of this.handlers.get(subject) ?? []) {
      for (let attempt = 1; attempt <= this.maxDeliveries; attempt++) {
        try {
          await handler(message, { attempt });
          break;
        } catch {
          // redeliver, like the broker would
        }
      }
    }
  }

  async subscribe(
    subject: string,
    _durable: string,
    handler: (message: unknown, delivery: Delivery) => Promise<void>,
  ): Promise<void> {
    this.handlers.set(subject, [...(this.handlers.get(subject) ?? []), handler]);
  }

  async close(): Promise<void> {}
}
