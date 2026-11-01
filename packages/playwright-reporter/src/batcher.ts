import type { TelemetryEvent } from './generated/TelemetryEvent';
import { isRetryable, sleep } from './http';
import type { Logger } from './logger';

export interface BatcherOptions {
  /** Flush at least this often. */
  flushIntervalMs: number;
  /** Flush as soon as this many events are queued; also the batch size. */
  maxBatchSize: number;
  /** Oldest events are dropped beyond this (server unreachable for a long time). */
  maxQueueSize: number;
  /** Retries per batch before leaving it queued for the next flush. */
  retries: number;
  retryBaseDelayMs: number;
}

type Outcome = 'sent' | 'dropped' | 'retry-later';

interface Pending {
  seq: number;
  event: TelemetryEvent;
}

/**
 * In-memory event queue with a single request in flight, so the server
 * receives events in the order they happened.
 *
 * A batch that fails transiently stays at the head of the queue and is retried
 * on the next flush; the server deduplicates, so re-sending is always safe.
 */
export class Batcher {
  private queue: Pending[] = [];
  private seq = 0;
  /** Every event with a lower or equal seq has been sent or dropped. */
  private settledSeq = 0;
  private readonly droppedSeqs = new Set<number>();
  private waiters: { seq: number; resolve: (delivered: boolean) => void }[] = [];
  private inFlight?: Promise<void>;
  private flushAgain = false;
  private timer?: NodeJS.Timeout;
  private warnedOutage = false;
  dropped = 0;

  constructor(
    private readonly send: (events: TelemetryEvent[]) => Promise<void>,
    private readonly options: BatcherOptions,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
    this.timer.unref();
  }

  /** Queues an event and returns its sequence number. */
  enqueue(event: TelemetryEvent): number {
    const seq = ++this.seq;
    this.queue.push({ seq, event });
    if (this.queue.length > this.options.maxQueueSize) {
      const overflow = this.queue.splice(0, this.queue.length - this.options.maxQueueSize);
      this.settle(overflow, false);
      this.dropped += overflow.length;
    }
    if (this.queue.length >= this.options.maxBatchSize) void this.flush();
    return seq;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Resolves once the event is stored (true) or given up on (false). */
  waitForDelivery(seq: number): Promise<boolean> {
    if (seq <= this.settledSeq) return Promise.resolve(!this.droppedSeqs.has(seq));
    return new Promise((resolve) => this.waiters.push({ seq, resolve }));
  }

  flush(): Promise<void> {
    if (this.inFlight) {
      this.flushAgain = true;
      return this.inFlight;
    }
    this.inFlight = this.drain().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Stops the timer and keeps flushing until the queue is empty or the deadline passes. */
  async close(deadline: number): Promise<boolean> {
    if (this.timer) clearInterval(this.timer);
    while (this.queue.length > 0 && Date.now() < deadline) {
      await this.flush();
      if (this.queue.length > 0) await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
    }
    const delivered = this.queue.length === 0;
    if (!delivered) {
      this.dropped += this.queue.length;
      this.settle(this.queue.splice(0), false);
    }
    return delivered;
  }

  private async drain(): Promise<void> {
    do {
      this.flushAgain = false;
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, this.options.maxBatchSize);
        const outcome = await this.sendWithRetry(batch.map((p) => p.event));
        if (outcome === 'retry-later') return;
        // Remove by sequence number: overflow trimming may have shifted the queue meanwhile.
        const last = batch[batch.length - 1].seq;
        while (this.queue.length > 0 && this.queue[0].seq <= last) this.queue.shift();
        if (outcome === 'dropped') this.dropped += batch.length;
        this.settle(batch, outcome === 'sent');
      }
    } while (this.flushAgain && this.queue.length > 0);
  }

  private async sendWithRetry(events: TelemetryEvent[]): Promise<Outcome> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.send(events);
        if (this.warnedOutage) {
          this.log.info('connection to the KlovPlay server restored');
          this.warnedOutage = false;
        }
        return 'sent';
      } catch (error) {
        if (!isRetryable(error)) {
          this.log.error(`dropping ${events.length} events the server rejected: ${(error as Error).message}`);
          return 'dropped';
        }
        if (attempt >= this.options.retries) {
          if (!this.warnedOutage) {
            this.log.warn(`cannot reach the KlovPlay server, will keep retrying: ${(error as Error).message}`);
            this.warnedOutage = true;
          }
          return 'retry-later';
        }
        const retryAfter = (error as { retryAfterMs?: number }).retryAfterMs ?? 0;
        await sleep(Math.max(this.options.retryBaseDelayMs * 2 ** attempt, retryAfter));
      }
    }
  }

  private settle(batch: Pending[], delivered: boolean): void {
    if (batch.length === 0) return;
    if (!delivered) for (const p of batch) this.droppedSeqs.add(p.seq);
    this.settledSeq = Math.max(this.settledSeq, batch[batch.length - 1].seq);
    const ready = this.waiters.filter((w) => w.seq <= this.settledSeq);
    this.waiters = this.waiters.filter((w) => w.seq > this.settledSeq);
    for (const waiter of ready) waiter.resolve(!this.droppedSeqs.has(waiter.seq));
  }
}
