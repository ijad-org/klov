import { randomUUID } from 'node:crypto';

import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

import { Batcher } from './batcher';
import type { EventBatchResponse } from './generated/EventBatchResponse';
import type { LaunchInit } from './generated/LaunchInit';
import type { LaunchInitResponse } from './generated/LaunchInitResponse';
import type { TelemetryEvent } from './generated/TelemetryEvent';
import { ApiClient, HttpError, withRetry } from './http';
import { createLogger, type Logger } from './logger';
import {
  detectCi,
  detectGit,
  effectiveStatus,
  errorFields,
  outputChunks,
  parseAnnotations,
  relativePath,
  suitePath,
} from './metadata';
import { type AttachmentSource, Uploader } from './uploader';

export interface KlovPlayReporterOptions {
  /** KlovPlay server URL. Env: KLOVPLAY_SERVER_URL. Default: http://localhost:8080 */
  serverUrl?: string;
  /** Project API key. Env: KLOVPLAY_API_KEY. */
  apiKey?: string;
  /** Project slug. Env: KLOVPLAY_PROJECT. */
  project?: string;
  /**
   * Shards reporting the same id merge into one launch.
   * Env: KLOVPLAY_CI_RUN_ID or CI_RUN_ID; otherwise derived from the CI provider, else random.
   */
  ciRunId?: string;
  buildNumber?: string;
  branch?: string;
  commitSha?: string;
  /** `steps-only` streams test.step() calls; `all-api` adds hooks, fixtures, page actions and expects. */
  stepMode?: 'steps-only' | 'all-api';
  /** Which attachments to upload. Default: all. */
  uploadAttachments?: 'all' | 'failures' | 'none';
  /** Larger attachments are skipped. Default: 500 MB. */
  maxAttachmentBytes?: number;
  uploadConcurrency?: number;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  /** How long onEnd waits for pending events and uploads. Default: 120 s. */
  finalTimeoutMs?: number;
  /** Set to false (or KLOVPLAY_DISABLED=1) to turn reporting off. */
  enabled?: boolean;
  debug?: boolean;
}

const STEP_CATEGORIES: Record<NonNullable<KlovPlayReporterOptions['stepMode']>, ReadonlySet<string>> = {
  'steps-only': new Set(['test.step']),
  'all-api': new Set(['test.step', 'hook', 'fixture', 'pw:api', 'expect']),
};

interface ExecutionRef {
  executionId: string;
  startSeq: number;
}

/**
 * Streams Playwright lifecycle events to KlovPlay while tests run.
 *
 * Reporting is best effort: the reporter never fails or slows the test run.
 * Playwright does not await onBegin/onTestEnd, so nothing blocks there: events
 * are queued and sent in ordered batches, and attachments upload in the background.
 */
export class KlovPlayReporter implements Reporter {
  private readonly options: KlovPlayReporterOptions;
  private log: Logger;
  private disabled = false;
  private api?: ApiClient;
  private batcher?: Batcher;
  private uploader?: Uploader;
  private launchId: Promise<string | null> = Promise.resolve(null);
  private dashboardUrl?: string;
  private heartbeat?: NodeJS.Timeout;
  private rootDir = process.cwd();
  private shard = { current: 1, total: 1 };
  private stepCategories: ReadonlySet<string> = STEP_CATEGORIES['steps-only'];
  private readonly executions = new WeakMap<TestResult, ExecutionRef>();
  private readonly steps = new WeakMap<TestStep, string>();

  constructor(options: KlovPlayReporterOptions = {}) {
    this.options = options;
    this.log = createLogger(!!options.debug || process.env.KLOVPLAY_DEBUG === '1');
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    const env = process.env;
    const o = this.options;
    const apiKey = o.apiKey ?? env.KLOVPLAY_API_KEY;
    const project = o.project ?? env.KLOVPLAY_PROJECT;
    if (o.enabled === false || env.KLOVPLAY_DISABLED === '1') {
      this.disabled = true;
      return;
    }
    if (!apiKey || !project) {
      this.log.warn('reporting disabled: set the apiKey and project options (or KLOVPLAY_API_KEY and KLOVPLAY_PROJECT)');
      this.disabled = true;
      return;
    }

    this.rootDir = config.rootDir;
    this.shard = config.shard ?? { current: 1, total: 1 };
    this.stepCategories = STEP_CATEGORIES[o.stepMode ?? 'steps-only'];
    const ci = detectCi(env);
    const git = ci.branch || ci.commitSha ? {} : detectGit(config.rootDir);
    let ciRunId = o.ciRunId ?? env.KLOVPLAY_CI_RUN_ID ?? env.CI_RUN_ID ?? ci.runId;
    if (!ciRunId) {
      ciRunId = randomUUID();
      if (this.shard.total > 1) this.log.warn('sharded run without CI_RUN_ID: each shard will appear as a separate launch');
    }

    this.api = new ApiClient(o.serverUrl ?? env.KLOVPLAY_SERVER_URL ?? 'http://localhost:8080', apiKey);
    this.batcher = new Batcher((events) => this.sendEvents(events), {
      flushIntervalMs: o.flushIntervalMs ?? 300,
      maxBatchSize: o.maxBatchSize ?? 100,
      maxQueueSize: 50_000,
      retries: 3,
      retryBaseDelayMs: 500,
    }, this.log);
    this.uploader = new Uploader(this.api, this.batcher, () => this.launchId, {
      concurrency: o.uploadConcurrency ?? 4,
      maxBytes: o.maxAttachmentBytes ?? 500 * 1024 * 1024,
      timeoutMs: 10 * 60_000,
    }, this.log);

    this.launchId = this.initLaunch({
      project_slug: project,
      ci_run_id: ciRunId,
      build_number: o.buildNumber ?? env.KLOVPLAY_BUILD_NUMBER ?? ci.buildNumber ?? null,
      branch: o.branch ?? env.KLOVPLAY_BRANCH ?? ci.branch ?? git.branch ?? null,
      commit_sha: o.commitSha ?? env.KLOVPLAY_COMMIT_SHA ?? ci.commitSha ?? git.commitSha ?? null,
      shard_index: this.shard.current,
      total_shards: this.shard.total,
      shard_total_tests: suite.allTests().length,
      timestamp: new Date().toISOString(),
    });
    this.batcher.start();
    this.heartbeat = setInterval(() => void this.sendHeartbeat(), 60_000);
    this.heartbeat.unref();
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    if (this.disabled || !this.batcher) return;
    const executionId = randomUUID();
    const startSeq = this.batcher.enqueue({
      type: 'TEST_START',
      launch_id: '',
      execution_id: executionId,
      playwright_test_id: test.id,
      title: test.title,
      file_path: relativePath(this.rootDir, test.location.file),
      line: test.location.line,
      suite_path: suitePath(test),
      browser_project: test.parent.project()?.name ?? '',
      worker_index: result.workerIndex,
      parallel_index: result.parallelIndex,
      shard_index: this.shard.current,
      retry_attempt: result.retry,
      annotations: parseAnnotations(test.annotations, test.tags),
      timestamp: result.startTime.toISOString(),
    });
    this.executions.set(result, { executionId, startSeq });
  }

  onStepBegin(_test: TestCase, result: TestResult, step: TestStep): void {
    if (this.disabled || !this.batcher || !this.stepCategories.has(step.category)) return;
    const execution = this.executions.get(result);
    if (!execution) return;
    const stepId = randomUUID();
    this.steps.set(step, stepId);
    let parent = step.parent;
    while (parent && !this.steps.has(parent)) parent = parent.parent;
    this.batcher.enqueue({
      type: 'STEP_START',
      launch_id: '',
      execution_id: execution.executionId,
      step_id: stepId,
      parent_step_id: parent ? this.steps.get(parent)! : null,
      title: step.title,
      category: step.category,
      timestamp: step.startTime.toISOString(),
    });
  }

  onStepEnd(_test: TestCase, result: TestResult, step: TestStep): void {
    const stepId = this.steps.get(step);
    const execution = this.executions.get(result);
    if (this.disabled || !this.batcher || !stepId || !execution) return;
    this.batcher.enqueue({
      type: 'STEP_END',
      launch_id: '',
      execution_id: execution.executionId,
      step_id: stepId,
      status: step.error ? 'failed' : 'passed',
      duration_ms: Math.max(0, Math.round(step.duration)),
      error_message: step.error?.message ?? null,
      timestamp: new Date(step.startTime.getTime() + Math.max(0, step.duration)).toISOString(),
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const execution = this.executions.get(result);
    if (this.disabled || !this.batcher || !this.uploader || !execution) return;
    const status = effectiveStatus(test, result);
    const runtimeAnnotations = (result as { annotations?: TestCase['annotations'] }).annotations ?? [];
    // Sent right away; attachments follow out of band so they never delay the result.
    this.batcher.enqueue({
      type: 'TEST_END',
      launch_id: '',
      execution_id: execution.executionId,
      status,
      duration_ms: Math.max(0, Math.round(result.duration)),
      ...errorFields(test, result, status),
      stdout: outputChunks(result.stdout),
      stderr: outputChunks(result.stderr),
      annotations: parseAnnotations([...test.annotations, ...runtimeAnnotations], test.tags),
      timestamp: new Date(result.startTime.getTime() + Math.max(0, result.duration)).toISOString(),
    });

    const policy = this.options.uploadAttachments ?? 'all';
    const failed = status !== 'passed' && status !== 'skipped';
    if (policy === 'none' || (policy === 'failures' && !failed)) return;
    const attachments: AttachmentSource[] = result.attachments
      .filter((a) => a.path || a.body)
      .map((a) => ({ name: a.name, contentType: a.contentType, path: a.path, body: a.body }));
    this.uploader.enqueue({ executionId: execution.executionId, startSeq: execution.startSeq, attachments });
  }

  async onEnd(result: FullResult): Promise<void> {
    if (this.disabled || !this.batcher || !this.uploader) return;
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      const deadline = Date.now() + (this.options.finalTimeoutMs ?? 120_000);
      await this.batcher.flush();
      const uploadsDone = await this.uploader.drain(deadline);
      if (!uploadsDone) this.log.warn('timed out waiting for attachment uploads');
      if (await this.launchId) {
        this.batcher.enqueue({
          type: 'SHARD_END',
          launch_id: '',
          shard_index: this.shard.current,
          status: result.status,
          timestamp: new Date().toISOString(),
        });
      }
      const delivered = await this.batcher.close(deadline);
      if (!delivered || this.batcher.dropped > 0) this.log.warn(`${this.batcher.dropped} events could not be delivered`);
      if (this.uploader.failed > 0) this.log.warn(`${this.uploader.failed} attachments could not be uploaded`);
      if (this.dashboardUrl) this.log.info(`report: ${this.dashboardUrl}`);
    } catch (error) {
      this.log.error(`failed to finish reporting: ${(error as Error).message}`);
    }
  }

  private async initLaunch(init: LaunchInit): Promise<string | null> {
    try {
      const response = await withRetry(() => this.api!.post<LaunchInitResponse>('/api/v1/launches/init', init), {
        retries: 4,
        baseDelayMs: 500,
      });
      this.dashboardUrl = response.dashboard_url;
      this.log.info(`streaming results live to ${response.dashboard_url}`);
      return response.launch_id;
    } catch (error) {
      this.log.error(`could not start a launch, results will not be reported: ${(error as Error).message}`);
      this.disabled = true;
      return null;
    }
  }

  private async sendEvents(events: TelemetryEvent[]): Promise<void> {
    const launchId = await this.launchId;
    if (!launchId) throw new HttpError(410, 'launch was not initialized');
    // Events queued before the launch existed carry an empty launch_id.
    const stamped = events.map((event) => ({ ...event, launch_id: launchId }) as TelemetryEvent);
    await this.api!.post<EventBatchResponse>('/api/v1/events/batch', { events: stamped });
  }

  private async sendHeartbeat(): Promise<void> {
    const launchId = await this.launchId;
    if (!launchId || !this.api) return;
    await this.api.post(`/api/v1/launches/${launchId}/heartbeat`, {}).catch(() => undefined);
  }
}

export default KlovPlayReporter;
