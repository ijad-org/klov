import { createReadStream } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Network failures, timeouts, overload and "not ready yet" (409) are worth retrying. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  return true;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
}

/** Exponential backoff that honours `Retry-After`. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= options.retries || !isRetryable(error)) throw error;
      const backoff = options.baseDelayMs * 2 ** attempt;
      const retryAfter = error instanceof HttpError ? error.retryAfterMs : undefined;
      await sleep(Math.max(backoff, retryAfter ?? 0));
    }
  }
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // not JSON
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new HttpError(
        response.status,
        `${path} → ${response.status}: ${message.slice(0, 300)}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

export type UploadSource = { path: string } | { body: Buffer };

/**
 * Streams a file (or buffer) to a pre-signed URL. Uses node:http rather than fetch
 * so the body streams from disk with an explicit Content-Length, which S3 requires.
 */
export function putObject(url: string, source: UploadSource, contentType: string, size: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(
      target,
      { method: 'PUT', headers: { 'content-type': contentType, 'content-length': size }, timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else reject(new HttpError(status, `upload → ${status}: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`));
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error(`upload timed out after ${timeoutMs}ms`)));
    if ('body' in source) {
      request.end(source.body);
    } else {
      createReadStream(source.path)
        .on('error', (error) => request.destroy(error))
        .pipe(request);
    }
  });
}
