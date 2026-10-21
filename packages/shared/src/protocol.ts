/**
 * Klov ingestion protocol (v1).
 *
 * Reporters stream ordered batches of events to the server while a test run is
 * executing. Every event is idempotent: re-sending a batch after a timeout never
 * duplicates data, so clients can retry freely.
 *
 *   POST /api/v1/ingest/runs                      -> start (or join) a run
 *   POST /api/v1/ingest/runs/:runId/events        -> ordered event batch
 *   PUT  /api/v1/ingest/runs/:runId/attachments/:attachmentId  -> raw blob
 *   POST /api/v1/ingest/runs/:runId/finish        -> shard / run finished
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** Raw result status of a single attempt, as reported by Playwright. */
export const AttemptStatusSchema = z.enum(['running', 'passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

/** Playwright's verdict for a test across all of its attempts. */
export const OutcomeSchema = z.enum(['expected', 'unexpected', 'flaky', 'skipped']);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const LocationSchema = z.object({
  file: z.string(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
});
export type Location = z.infer<typeof LocationSchema>;

export const AnnotationSchema = z.object({
  type: z.string().max(200),
  description: z.string().max(10_000).optional(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

export const ErrorInfoSchema = z.object({
  message: z.string().max(100_000).optional(),
  stack: z.string().max(100_000).optional(),
  snippet: z.string().max(20_000).optional(),
  location: LocationSchema.optional(),
});
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;

export interface StepNode {
  title: string;
  category: string;
  /** Milliseconds since the attempt started. */
  offsetMs: number;
  durationMs: number;
  error?: { message?: string };
  location?: Location;
  attachmentIds?: string[];
  steps?: StepNode[];
}

export const StepNodeSchema: z.ZodType<StepNode> = z.lazy(() =>
  z.object({
    title: z.string().max(5_000),
    category: z.string().max(100),
    offsetMs: z.number(),
    durationMs: z.number(),
    error: z.object({ message: z.string().max(20_000).optional() }).optional(),
    location: LocationSchema.optional(),
    attachmentIds: z.array(z.string()).optional(),
    steps: z.array(StepNodeSchema).optional(),
  }),
);

/** Static description of a test case; sent with the plan and repeated on begin/end so the server never depends on ordering. */
export const TestMetaSchema = z.object({
  /** Playwright's test id. Unique within a run. */
  testId: z.string().min(1).max(500),
  /** Stable identity across runs (project + file + title path). Drives history and flakiness analytics. */
  historyKey: z.string().min(1).max(200),
  title: z.string().max(5_000),
  /** describe() blocks, outermost first. */
  titlePath: z.array(z.string().max(5_000)).max(100),
  file: z.string().max(2_000),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  /** Playwright project name, e.g. "chromium". */
  project: z.string().max(500).default(''),
  tags: z.array(z.string().max(200)).max(200).default([]),
  annotations: z.array(AnnotationSchema).max(500).default([]),
  expectedStatus: AttemptStatusSchema.optional(),
  timeoutMs: z.number().optional(),
  maxRetries: z.number().int().optional(),
});
export type TestMeta = z.input<typeof TestMetaSchema>;

export const AttachmentMetaSchema = z.object({
  /** Client-generated UUID; the blob is uploaded separately under this id. */
  id: z.string().uuid(),
  name: z.string().max(1_000),
  contentType: z.string().max(200),
  size: z.number().int().nonnegative().optional(),
  /** True when the blob will not be uploaded (policy or size limit). */
  skipped: z.boolean().optional(),
});
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

export const ShardSchema = z.object({
  current: z.number().int().positive(),
  total: z.number().int().positive(),
});
export type Shard = z.infer<typeof ShardSchema>;

const PlanEvent = z.object({
  type: z.literal('plan'),
  shard: ShardSchema.optional(),
  tests: z.array(TestMetaSchema).max(5_000),
});

const TestBeginEvent = z.object({
  type: z.literal('test.begin'),
  test: TestMetaSchema,
  retry: z.number().int().nonnegative(),
  startTime: z.number(),
  workerIndex: z.number().int().optional(),
  parallelIndex: z.number().int().optional(),
  shard: z.number().int().optional(),
});

/** Ephemeral "what is this test doing right now" signal. Broadcast to dashboards, never persisted. */
const TestProgressEvent = z.object({
  type: z.literal('test.progress'),
  testId: z.string(),
  retry: z.number().int().nonnegative(),
  step: z.object({ title: z.string().max(2_000), category: z.string().max(100) }),
});

const TestEndEvent = z.object({
  type: z.literal('test.end'),
  test: TestMetaSchema,
  retry: z.number().int().nonnegative(),
  status: AttemptStatusSchema,
  /** Playwright's outcome after this attempt (test.outcome()). */
  outcome: OutcomeSchema,
  /** True when Playwright will run another attempt. */
  willRetry: z.boolean(),
  startTime: z.number(),
  durationMs: z.number(),
  workerIndex: z.number().int().optional(),
  parallelIndex: z.number().int().optional(),
  shard: z.number().int().optional(),
  errors: z.array(ErrorInfoSchema).max(50).default([]),
  steps: z.array(StepNodeSchema).default([]),
  attachments: z.array(AttachmentMetaSchema).max(500).default([]),
  stdout: z.string().max(1_000_000).optional(),
  stderr: z.string().max(1_000_000).optional(),
  /** Annotations added while the test was running (test.info().annotations). */
  annotations: z.array(AnnotationSchema).max(500).optional(),
});

const RunErrorEvent = z.object({
  type: z.literal('run.error'),
  error: ErrorInfoSchema,
});

export const IngestEventSchema = z.discriminatedUnion('type', [
  PlanEvent,
  TestBeginEvent,
  TestProgressEvent,
  TestEndEvent,
  RunErrorEvent,
]);
export type IngestEvent = z.input<typeof IngestEventSchema>;
export type ParsedIngestEvent = z.output<typeof IngestEventSchema>;
export type TestEndPayload = z.output<typeof TestEndEvent>;
export type TestBeginPayload = z.output<typeof TestBeginEvent>;

export const EventBatchSchema = z.object({
  events: z.array(IngestEventSchema).max(10_000),
});

export const CiInfoSchema = z.object({
  provider: z.string().max(100).optional(),
  buildId: z.string().max(500).optional(),
  buildUrl: z.string().max(2_000).optional(),
  branch: z.string().max(500).optional(),
  commit: z.string().max(100).optional(),
  commitMessage: z.string().max(5_000).optional(),
  commitUrl: z.string().max(2_000).optional(),
  pullRequest: z.string().max(100).optional(),
  pullRequestUrl: z.string().max(2_000).optional(),
  author: z.string().max(500).optional(),
  repository: z.string().max(1_000).optional(),
});
export type CiInfo = z.infer<typeof CiInfoSchema>;

export const StartRunSchema = z.object({
  protocol: z.number().int().default(PROTOCOL_VERSION),
  project: z.string().min(1).max(200),
  projectName: z.string().max(200).optional(),
  name: z.string().max(500).optional(),
  /** Runs started with the same key are merged (e.g. Playwright shards of one CI build). */
  runKey: z.string().max(500).optional(),
  shard: ShardSchema.optional(),
  startTime: z.number().optional(),
  tags: z.array(z.string().max(200)).max(100).default([]),
  ci: CiInfoSchema.default({}),
  environment: z.record(z.string(), z.string().max(10_000)).default({}),
  config: z
    .object({
      playwrightVersion: z.string().optional(),
      workers: z.number().optional(),
      retries: z.number().optional(),
      projects: z.array(z.object({ name: z.string(), browser: z.string().optional() })).optional(),
      rootDir: z.string().optional(),
      reporterVersion: z.string().optional(),
    })
    .passthrough()
    .default({}),
});
export type StartRunRequest = z.input<typeof StartRunSchema>;

export interface StartRunResponse {
  runId: string;
  projectId: string;
  projectSlug: string;
  seq: number;
  url: string;
}

export const FinishRunSchema = z.object({
  status: z.enum(['passed', 'failed', 'timedout', 'interrupted']),
  shard: ShardSchema.optional(),
  endTime: z.number().optional(),
  durationMs: z.number().optional(),
});
export type FinishRunRequest = z.input<typeof FinishRunSchema>;
