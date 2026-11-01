import { describe, expect, it } from 'vitest';

import type { LaunchDetail } from '../generated/LaunchDetail';
import type { SseStateDiff } from '../generated/SseStateDiff';
import { row } from '../test/fixtures';
import { applyDiffs } from './useLaunchStream';

const detail: LaunchDetail = {
  launch: {
    id: 'l1', project_id: 'p', project_slug: 'web', ci_run_id: 'r', build_number: null, branch: null, commit_sha: null,
    status: 'running', total_tests: 2, passed_count: 0, failed_count: 0, flaky_count: 0, skipped_count: 0, running_count: 1,
    total_shards: 1, completed_shards: 0, started_at: '2026-11-01T00:00:00Z', ended_at: null, duration_ms: null,
  },
  workers: [],
  clusters: [],
  retry_command: null,
};

describe('applyDiffs', () => {
  it('updates counters, workers and rows; retries replace earlier attempts', () => {
    const history = [{ launch_id: 'old', execution_id: 'x', status: 'passed', duration_ms: 90 }];
    const rows = [row({ playwright_test_id: 't1', execution_id: 'e0', status: 'running', history })];
    const diffs: SseStateDiff[] = [
      { kind: 'COUNTERS_UPDATED', launch_id: 'l1', total_tests: 2, passed: 1, failed: 0, flaky: 0, skipped: 0, running: 1 },
      { kind: 'WORKER_ACTIVITY', worker_id: 'shard-1-worker-3', execution_id: 'e1', test_title: 't', current_step: 'click', status: 'running', started_at: '2026-11-01T00:00:01Z' },
      { kind: 'TEST_ROW_UPDATED', ...row({ playwright_test_id: 't1', execution_id: 'e1', retry_attempt: 1, status: 'flaky' }) },
      { kind: 'TEST_ROW_UPDATED', ...row({ playwright_test_id: 't0', execution_id: 'e9', file_path: '0.spec.ts', status: 'running' }) },
    ];
    const result = applyDiffs(detail, rows, diffs);
    expect(result.detail?.launch.passed_count).toBe(1);
    expect(result.detail?.workers[0]).toMatchObject({ shard_index: 1, parallel_index: 3, current_step: 'click' });
    expect(result.rows?.map((r) => [r.playwright_test_id, r.status])).toEqual([['t0', 'running'], ['t1', 'flaky']]);
    expect(result.rows?.[1].history).toEqual(history);
    expect(result.changedExecutions).toEqual(new Set(['e1', 'e0', 'e9']));
    expect(rows[0].status).toBe('running');
  });

  it('ignores a stale attempt arriving after a newer one', () => {
    const rows = [row({ playwright_test_id: 't1', execution_id: 'e1', retry_attempt: 1, status: 'passed' })];
    const result = applyDiffs(detail, rows, [{ kind: 'TEST_ROW_UPDATED', ...row({ playwright_test_id: 't1', execution_id: 'e0', retry_attempt: 0, status: 'failed' }) }]);
    expect(result.rows?.[0].execution_id).toBe('e1');
  });

  it('marks the launch finished and workers idle on completion', () => {
    const result = applyDiffs(detail, [], [{ kind: 'LAUNCH_COMPLETED', launch_id: 'l1', status: 'passed', ended_at: '2026-11-01T00:01:00Z' }]);
    expect(result.detail?.launch).toMatchObject({ status: 'passed', running_count: 0 });
    expect(result.failuresChanged).toBe(true);
  });
});
