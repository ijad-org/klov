import type { RunStats, TestStatus } from './model.js';
import type { AttemptStatus, ErrorInfo, Outcome } from './protocol.js';

const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function emptyStats(): RunStats {
  return { total: 0, queued: 0, running: 0, passed: 0, failed: 0, broken: 0, flaky: 0, skipped: 0, interrupted: 0 };
}

/** Tests that ran to a verdict (excludes skipped and not-yet-finished tests). */
export function executedCount(stats: RunStats): number {
  return stats.passed + stats.flaky + stats.failed + stats.broken + stats.interrupted;
}

/** Share of executed tests that eventually passed (flaky counts as passed), or null if nothing executed. */
export function passRate(stats: RunStats): number | null {
  const executed = executedCount(stats);
  return executed === 0 ? null : (stats.passed + stats.flaky) / executed;
}

export function finishedCount(stats: RunStats): number {
  return stats.total - stats.queued - stats.running;
}

const ASSERTION_PATTERN = /expect\(|AssertionError|toMatchSnapshot|toHaveScreenshot|Expected:|Received:/;

/** Distinguishes failed assertions (product defects) from other errors (test defects). */
export function isAssertionError(error: ErrorInfo | undefined): boolean {
  if (!error?.message) return false;
  return ASSERTION_PATTERN.test(stripAnsi(error.message));
}

export interface AttemptVerdict {
  status: AttemptStatus;
  outcome: Outcome;
  willRetry: boolean;
  errors: ErrorInfo[];
}

/** Maps a Playwright attempt result to the Klov status of the test case. */
export function deriveTestStatus(v: AttemptVerdict): TestStatus {
  if (v.willRetry) return 'running';
  switch (v.outcome) {
    case 'skipped':
      return 'skipped';
    case 'flaky':
      return 'flaky';
    case 'expected':
      return 'passed';
    case 'unexpected':
      if (v.status === 'interrupted') return 'interrupted';
      if (v.status === 'timedOut') return 'broken';
      // A test marked test.fail() that passed is reported as unexpected with status "passed".
      if (v.status === 'passed') return 'failed';
      return isAssertionError(v.errors[0]) ? 'failed' : 'broken';
  }
}

/** Sort weight: problems first, then in-flight, then healthy. */
export const STATUS_SEVERITY: Record<TestStatus, number> = {
  failed: 0,
  broken: 1,
  interrupted: 2,
  flaky: 3,
  running: 4,
  queued: 5,
  passed: 6,
  skipped: 7,
};

export function isFinalStatus(status: TestStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

export function isFailureStatus(status: TestStatus): boolean {
  return status === 'failed' || status === 'broken' || status === 'interrupted';
}
