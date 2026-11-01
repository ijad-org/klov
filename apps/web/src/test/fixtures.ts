import type { TestRow } from '../generated/TestRow';

/** A test row with sensible defaults for unit tests. */
export function row(overrides: Partial<TestRow>): TestRow {
  return {
    execution_id: overrides.playwright_test_id ?? 'e1',
    launch_id: 'l1',
    playwright_test_id: 't1',
    fingerprint: 'f',
    title: 'test',
    file_path: 'a.spec.ts',
    line: 1,
    suite_path: [],
    browser_project: 'chromium',
    worker_index: 0,
    parallel_index: 0,
    shard_index: 1,
    retry_attempt: 0,
    status: 'passed',
    duration_ms: 100,
    error_message: null,
    error_cluster_hash: null,
    annotations: { tags: [] },
    started_at: '2026-11-01T00:00:00Z',
    ended_at: null,
    history: [],
    avg_duration_ms: null,
    ...overrides,
  };
}
