import { describe, expect, it } from 'vitest';

import { Batcher } from './batcher';
import type { TelemetryEvent } from './generated/TelemetryEvent';
import { HttpError } from './http';
import type { Logger } from './logger';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const options = { flushIntervalMs: 1_000, maxBatchSize: 3, maxQueueSize: 100, retries: 2, retryBaseDelayMs: 1 };

function event(n: number): TelemetryEvent {
  return { type: 'SHARD_END', launch_id: '', shard_index: n, status: null, timestamp: new Date(0).toISOString() };
}
const shardOf = (e: TelemetryEvent) => (e.type === 'SHARD_END' ? e.shard_index : -1);

describe('Batcher', () => {
  it('sends batches in order with one request in flight', async () => {
    const sent: number[][] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const batcher = new Batcher(async (events) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      sent.push(events.map(shardOf));
      inFlight--;
    }, options, silent);
    for (let i = 1; i <= 7; i++) batcher.enqueue(event(i));
    await batcher.flush();
    await batcher.flush();
    expect(maxInFlight).toBe(1);
    expect(sent.flat()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(sent.every((batch) => batch.length <= 3)).toBe(true);
  });

  it('retries transient failures and resolves delivery waiters', async () => {
    let calls = 0;
    const batcher = new Batcher(async () => {
      calls++;
      if (calls < 3) throw new HttpError(503, 'busy');
    }, options, silent);
    const seq = batcher.enqueue(event(1));
    const delivered = batcher.waitForDelivery(seq);
    await batcher.flush();
    expect(calls).toBe(3);
    await expect(delivered).resolves.toBe(true);
    expect(batcher.pending).toBe(0);
  });

  it('keeps events queued while the server is unreachable', async () => {
    let up = false;
    const received: number[] = [];
    const batcher = new Batcher(async (events) => {
      if (!up) throw new TypeError('fetch failed');
      received.push(...events.map(shardOf));
    }, options, silent);
    batcher.enqueue(event(1));
    batcher.enqueue(event(2));
    await batcher.flush();
    expect(batcher.pending).toBe(2);
    up = true;
    batcher.enqueue(event(3));
    await batcher.close(Date.now() + 1_000);
    expect(received).toEqual([1, 2, 3]);
  });

  it('drops batches the server rejects and reports them undelivered', async () => {
    const batcher = new Batcher(async () => {
      throw new HttpError(400, 'bad event');
    }, options, silent);
    const seq = batcher.enqueue(event(1));
    await batcher.flush();
    await expect(batcher.waitForDelivery(seq)).resolves.toBe(false);
    expect(batcher.dropped).toBe(1);
    expect(batcher.pending).toBe(0);
  });

  it('gives up on close after the deadline', async () => {
    const batcher = new Batcher(async () => {
      throw new TypeError('fetch failed');
    }, options, silent);
    const seq = batcher.enqueue(event(1));
    expect(await batcher.close(Date.now() + 50)).toBe(false);
    await expect(batcher.waitForDelivery(seq)).resolves.toBe(false);
  });
});
