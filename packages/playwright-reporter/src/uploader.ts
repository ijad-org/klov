import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import type { Batcher } from './batcher';
import type { PresignResponse } from './generated/PresignResponse';
import { type ApiClient, putObject, type UploadSource, withRetry } from './http';
import type { Logger } from './logger';

export interface AttachmentSource {
  name: string;
  contentType: string;
  path?: string;
  body?: Buffer;
}

export interface UploadJob {
  executionId: string;
  /** Sequence number of the TEST_START; artifacts can only be registered once it is stored. */
  startSeq: number;
  attachments: AttachmentSource[];
}

export interface UploaderOptions {
  concurrency: number;
  maxBytes: number;
  timeoutMs: number;
}

interface PreparedFile {
  name: string;
  fileName: string;
  contentType: string;
  size: number;
  source: UploadSource;
}

/**
 * Uploads attachments out of band, straight to object storage via pre-signed URLs,
 * so test results are never delayed by large traces or videos.
 */
export class Uploader {
  private queue: UploadJob[] = [];
  private active = 0;
  private idleWaiters: (() => void)[] = [];
  uploaded = 0;
  failed = 0;

  constructor(
    private readonly api: ApiClient,
    private readonly batcher: Batcher,
    private readonly launchId: () => Promise<string | null>,
    private readonly options: UploaderOptions,
    private readonly log: Logger,
  ) {}

  enqueue(job: UploadJob): void {
    if (job.attachments.length === 0) return;
    this.queue.push(job);
    this.pump();
  }

  /** Waits for queued uploads; returns false if the deadline passed first. */
  async drain(deadline: number): Promise<boolean> {
    if (this.active === 0 && this.queue.length === 0) return true;
    const idle = new Promise<boolean>((resolve) => this.idleWaiters.push(() => resolve(true)));
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())).unref());
    return Promise.race([idle, timeout]);
  }

  private pump(): void {
    while (this.active < this.options.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active++;
      this.run(job)
        .catch((error: Error) => {
          this.failed += job.attachments.length;
          this.log.warn(`attachment upload failed: ${error.message}`);
        })
        .finally(() => {
          this.active--;
          this.pump();
          if (this.active === 0 && this.queue.length === 0) {
            for (const resolve of this.idleWaiters.splice(0)) resolve();
          }
        });
    }
  }

  private async prepare(attachment: AttachmentSource): Promise<PreparedFile | undefined> {
    let size: number;
    let source: UploadSource;
    if (attachment.body) {
      size = attachment.body.length;
      source = { body: attachment.body };
    } else if (attachment.path) {
      try {
        size = (await stat(attachment.path)).size;
      } catch {
        this.log.debug(`attachment ${attachment.path} no longer exists, skipping`);
        return undefined;
      }
      source = { path: attachment.path };
    } else {
      return undefined;
    }
    if (size > this.options.maxBytes) {
      this.log.warn(`skipping attachment "${attachment.name}" (${size} bytes > maxAttachmentBytes)`);
      return undefined;
    }
    const fileName = attachment.path ? basename(attachment.path) : attachment.name;
    return { name: attachment.name, fileName, contentType: attachment.contentType, size, source };
  }

  private async run(job: UploadJob): Promise<void> {
    if (!(await this.batcher.waitForDelivery(job.startSeq))) return;
    const launchId = await this.launchId();
    if (!launchId) return;
    const files = (await Promise.all(job.attachments.map((a) => this.prepare(a)))).filter((f): f is PreparedFile => !!f);
    if (files.length === 0) return;

    const presigned = await withRetry(
      () =>
        this.api.post<PresignResponse>('/api/v1/artifacts/presign', {
          launch_id: launchId,
          execution_id: job.executionId,
          artifacts: files.map((f) => ({ name: f.name, content_type: f.contentType, size_bytes: f.size, file_name: f.fileName })),
        }),
      { retries: 4, baseDelayMs: 500 },
    );

    const completed: string[] = [];
    for (const [index, upload] of presigned.uploads.entries()) {
      const file = files[index];
      try {
        await withRetry(() => putObject(upload.upload_url, file.source, file.contentType, file.size, this.options.timeoutMs), {
          retries: 2,
          baseDelayMs: 1_000,
        });
        completed.push(upload.artifact_id);
      } catch (error) {
        this.failed++;
        this.log.warn(`could not upload "${file.name}": ${(error as Error).message}`);
      }
    }
    if (completed.length > 0) {
      await withRetry(() => this.api.post('/api/v1/artifacts/complete', { artifact_ids: completed }), { retries: 4, baseDelayMs: 500 });
      this.uploaded += completed.length;
    }
  }
}
