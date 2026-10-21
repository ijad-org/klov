/**
 * Read-model types returned by the Klov HTTP API and pushed over the live stream.
 */
import type { Annotation, AttemptStatus, CiInfo, ErrorInfo, Location, StepNode } from './protocol.js';

/**
 * Status of a test case in a run.
 *
 * - failed:  an assertion did not hold (product defect)
 * - broken:  the test itself errored or timed out (test defect)
 * - flaky:   failed at least once, then passed on retry
 */
export const TEST_STATUSES = ['queued', 'running', 'passed', 'failed', 'broken', 'flaky', 'skipped', 'interrupted'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

/** Statuses that mean the test has finished. */
export const FINAL_TEST_STATUSES: readonly TestStatus[] = ['passed', 'failed', 'broken', 'flaky', 'skipped', 'interrupted'];

export type RunStatus = 'running' | 'passed' | 'failed' | 'interrupted';

export interface RunStats {
  total: number;
  queued: number;
  running: number;
  passed: number;
  failed: number;
  broken: number;
  flaky: number;
  skipped: number;
  interrupted: number;
}

export interface Labels {
  severity?: string;
  owner?: string;
  epic?: string;
  feature?: string;
  story?: string;
  links?: { type: string; url: string; name: string }[];
}

export interface ProjectSettings {
  /** Failure categories, matched in order (first match wins). */
  categories?: CategoryRule[];
  /** e.g. "https://jira.example.com/browse/{}" — turns `issue` annotations into links. */
  issueUrlTemplate?: string;
  /** e.g. "https://tms.example.com/case/{}" — turns `tms` annotations into links. */
  tmsUrlTemplate?: string;
  /** Delete runs older than this many days (overrides the server default). */
  retentionDays?: number;
}

export interface CategoryRule {
  name: string;
  /** Statuses this rule applies to; defaults to failed + broken. */
  statuses?: TestStatus[];
  /** Regular expression matched against the error message. */
  messageRegex?: string;
  /** Regular expression matched against the stack trace. */
  traceRegex?: string;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  settings: ProjectSettings;
}

export interface ProjectSummary extends Project {
  runCount: number;
  latestRun: RunSummary | null;
  /** Most recent runs (newest first) for sparklines. */
  recent: { id: string; seq: number; status: RunStatus; passRate: number | null }[];
}

export interface RunSummary {
  id: string;
  projectId: string;
  projectSlug: string;
  seq: number;
  name: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  lastEventAt: string;
  stats: RunStats;
  ci: CiInfo;
  tags: string[];
  shardTotal: number | null;
  shardsFinished: number;
}

export interface RunDetail extends RunSummary {
  environment: Record<string, string>;
  config: Record<string, unknown>;
  errors: ErrorInfo[];
}

export interface TestSummary {
  id: string;
  runId: string;
  testId: string;
  historyKey: string;
  title: string;
  titlePath: string[];
  file: string;
  line: number | null;
  project: string;
  tags: string[];
  labels: Labels;
  status: TestStatus;
  retries: number;
  durationMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  errorMessage: string | null;
  category: string | null;
  shard: number | null;
}

export interface AttachmentInfo {
  id: string;
  name: string;
  contentType: string;
  size: number | null;
  retry: number | null;
  uploaded: boolean;
  skipped: boolean;
}

export interface AttemptDetail {
  retry: number;
  status: AttemptStatus;
  startedAt: string | null;
  durationMs: number | null;
  workerIndex: number | null;
  parallelIndex: number | null;
  errors: ErrorInfo[];
  steps: StepNode[];
  stdout: string | null;
  stderr: string | null;
  attachments: AttachmentInfo[];
}

export interface TestDetail extends TestSummary {
  annotations: Annotation[];
  expectedStatus: string | null;
  location: Location;
  attempts: AttemptDetail[];
  run: Pick<RunSummary, 'id' | 'seq' | 'name' | 'status' | 'projectSlug' | 'ci'>;
}

export interface HistoryEntry {
  testRowId: string;
  runId: string;
  runSeq: number;
  runName: string;
  status: TestStatus;
  durationMs: number | null;
  startedAt: string | null;
  branch: string | null;
  errorMessage: string | null;
}

export interface TestHistory {
  entries: HistoryEntry[];
  /** Share of finished entries that were flaky or flipped status vs. the previous entry. */
  flakinessRate: number;
  passRate: number;
  avgDurationMs: number | null;
}

export interface FailureCluster {
  fingerprint: string;
  signature: string;
  message: string;
  category: string | null;
  count: number;
  tests: Pick<TestSummary, 'id' | 'title' | 'titlePath' | 'file' | 'project' | 'status'>[];
}

export interface TimelineEntry {
  testRowId: string;
  title: string;
  project: string;
  retry: number;
  status: AttemptStatus;
  startMs: number;
  durationMs: number | null;
  shard: number | null;
  parallelIndex: number | null;
  workerIndex: number | null;
}

export interface TrendPoint {
  id: string;
  seq: number;
  name: string;
  status: RunStatus;
  startedAt: string;
  durationMs: number | null;
  stats: RunStats;
  branch: string | null;
}

export interface InsightTest {
  historyKey: string;
  title: string;
  titlePath: string[];
  file: string;
  project: string;
  runs: number;
  failures: number;
  flaky: number;
  flips: number;
  score: number;
  avgDurationMs: number | null;
  lastStatus: TestStatus;
  lastTestRowId: string;
  lastRunId: string;
}

export interface ProjectInsights {
  windowRuns: number;
  flaky: InsightTest[];
  failing: InsightTest[];
  slowest: InsightTest[];
}

export interface RunComparison {
  previous: Pick<RunSummary, 'id' | 'seq' | 'name' | 'status'> | null;
  newFailures: TestSummary[];
  fixed: TestSummary[];
  stillFailing: number;
  newTests: number;
}

export interface GroupBreakdown {
  key: string;
  stats: RunStats;
  durationMs: number;
}

export interface RunBreakdown {
  byProject: GroupBreakdown[];
  byFile: GroupBreakdown[];
  byCategory: { category: string; count: number }[];
  byTag: GroupBreakdown[];
  slowest: TestSummary[];
}

/** Messages pushed to dashboards over Server-Sent Events. */
export type LiveEvent =
  | { type: 'run.created'; run: RunSummary }
  | { type: 'run.updated'; run: RunSummary }
  | { type: 'tests.updated'; runId: string; tests: TestSummary[] }
  | { type: 'test.progress'; runId: string; testRowId?: string; testId: string; retry: number; step: { title: string; category: string } }
  | { type: 'run.deleted'; runId: string; projectId: string }
  | { type: 'invalidate'; runId?: string; projectId?: string };
