import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import type { LaunchDetail } from '../generated/LaunchDetail';
import type { SseStateDiff } from '../generated/SseStateDiff';
import type { TestRow } from '../generated/TestRow';
import type { WorkerState } from '../generated/WorkerState';
import { api, queryKeys } from '../lib/api';

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'closed';

function compareRows(a: TestRow, b: TestRow): number {
  return a.file_path.localeCompare(b.file_path) || a.line - b.line || a.browser_project.localeCompare(b.browser_project);
}

/** Applies a batch of diffs to the cached launch and test list. Exported for tests. */
export function applyDiffs(
  detail: LaunchDetail | undefined,
  rows: TestRow[] | undefined,
  diffs: SseStateDiff[],
): { detail: LaunchDetail | undefined; rows: TestRow[] | undefined; changedExecutions: Set<string>; failuresChanged: boolean } {
  const changedExecutions = new Set<string>();
  let failuresChanged = false;
  let nextDetail = detail;
  let nextRows = rows;
  let rowIndex: Map<string, number> | undefined;

  for (const diff of diffs) {
    switch (diff.kind) {
      case 'COUNTERS_UPDATED':
        if (nextDetail) {
          nextDetail = {
            ...nextDetail,
            launch: {
              ...nextDetail.launch,
              total_tests: diff.total_tests,
              passed_count: diff.passed,
              failed_count: diff.failed,
              flaky_count: diff.flaky,
              skipped_count: diff.skipped,
              running_count: diff.running,
            },
          };
        }
        break;
      case 'WORKER_ACTIVITY': {
        if (!nextDetail) break;
        const match = /^shard-(\d+)-worker-(\d+)$/.exec(diff.worker_id);
        const worker: WorkerState = {
          worker_id: diff.worker_id,
          shard_index: match ? Number(match[1]) : 1,
          parallel_index: match ? Number(match[2]) : 0,
          execution_id: diff.execution_id ?? null,
          test_title: diff.test_title ?? null,
          current_step: diff.current_step ?? null,
          status: diff.status,
          started_at: diff.started_at,
        };
        const workers = nextDetail.workers.filter((w) => w.worker_id !== diff.worker_id);
        workers.push(worker);
        workers.sort((a, b) => a.shard_index - b.shard_index || a.parallel_index - b.parallel_index);
        nextDetail = { ...nextDetail, workers };
        break;
      }
      case 'TEST_ROW_UPDATED': {
        if (!nextRows) break;
        const { kind: _kind, ...row } = diff;
        if (nextRows === rows) nextRows = [...rows];
        if (!rowIndex) rowIndex = new Map(nextRows.map((r, i) => [r.playwright_test_id, i]));
        const existingAt = rowIndex.get(row.playwright_test_id);
        changedExecutions.add(row.execution_id);
        if (row.status === 'failed' || row.status === 'timedOut' || row.status === 'interrupted') failuresChanged = true;
        if (existingAt === undefined) {
          nextRows.push({ ...row, history: [], avg_duration_ms: null });
          nextRows.sort(compareRows);
          rowIndex = new Map(nextRows.map((r, i) => [r.playwright_test_id, i]));
          break;
        }
        const existing = nextRows[existingAt];
        if (existing.retry_attempt > row.retry_attempt) break;
        if (existing.execution_id !== row.execution_id) changedExecutions.add(existing.execution_id);
        if (existing.status === 'failed' || existing.status === 'timedOut') failuresChanged = true;
        nextRows[existingAt] = {
          ...row,
          history: row.history.length ? row.history : existing.history,
          avg_duration_ms: row.avg_duration_ms ?? existing.avg_duration_ms,
        };
        break;
      }
      case 'ARTIFACT_UPLOADED':
        changedExecutions.add(diff.execution_id);
        break;
      case 'LAUNCH_COMPLETED':
        if (nextDetail) {
          nextDetail = {
            ...nextDetail,
            launch: { ...nextDetail.launch, status: diff.status, ended_at: diff.ended_at, running_count: 0 },
            workers: nextDetail.workers.map((w) => ({ ...w, status: 'idle', current_step: null })),
          };
        }
        failuresChanged = true;
        break;
    }
  }
  return { detail: nextDetail, rows: nextRows, changedExecutions, failuresChanged };
}

/** Open test details refetch when their execution changes or gets new artifacts. */
function refreshExecutions(client: QueryClient, changedExecutions: Set<string>) {
  for (const id of changedExecutions) void client.invalidateQueries({ queryKey: queryKeys.execution(id) });
}

/**
 * Loads a launch over REST, then keeps it current with the launch's SSE stream.
 * Diffs are applied once per animation frame, so even very busy runs re-render smoothly.
 */
export function useLaunchStream(launchId: string) {
  const client = useQueryClient();
  const detail = useQuery({ queryKey: queryKeys.launch(launchId), queryFn: () => api.launch(launchId) });
  const tests = useQuery({ queryKey: queryKeys.tests(launchId), queryFn: () => api.tests(launchId) });
  const [state, setState] = useState<StreamState>('connecting');
  const clustersTimer = useRef<number | undefined>(undefined);
  const status = detail.data?.launch.status;

  useEffect(() => {
    if (status && status !== 'running') {
      setState('closed');
      return;
    }
    const source = new EventSource(`/api/v1/launches/${launchId}/stream`);
    let pending: SseStateDiff[] = [];
    let frame: number | undefined;

    const flush = () => {
      frame = undefined;
      const diffs = pending;
      pending = [];
      const result = applyDiffs(
        client.getQueryData<LaunchDetail>(queryKeys.launch(launchId)),
        client.getQueryData<TestRow[]>(queryKeys.tests(launchId)),
        diffs,
      );
      if (result.detail) client.setQueryData(queryKeys.launch(launchId), result.detail);
      if (result.rows) client.setQueryData(queryKeys.tests(launchId), result.rows);
      refreshExecutions(client, result.changedExecutions);
      if (diffs.some((d) => d.kind === 'LAUNCH_COMPLETED')) {
        // Final durations, clusters and history.
        void client.invalidateQueries({ queryKey: queryKeys.launch(launchId) });
        void client.invalidateQueries({ queryKey: queryKeys.tests(launchId) });
      } else if (result.failuresChanged && clustersTimer.current === undefined) {
        // Failure clusters are computed server-side; refresh them at most every 2 s.
        clustersTimer.current = window.setTimeout(() => {
          clustersTimer.current = undefined;
          void client.invalidateQueries({ queryKey: queryKeys.launch(launchId) });
        }, 2_000);
      }
    };

    source.onopen = () => {
      setState('live');
      // Anything that happened before the stream opened is picked up by a refetch.
      void client.invalidateQueries({ queryKey: queryKeys.launch(launchId) });
      void client.invalidateQueries({ queryKey: queryKeys.tests(launchId) });
    };
    source.onerror = () => setState(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    source.onmessage = (event) => {
      try {
        pending.push(JSON.parse(event.data) as SseStateDiff);
      } catch {
        return;
      }
      frame ??= requestAnimationFrame(flush);
    };
    return () => {
      source.close();
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (clustersTimer.current !== undefined) window.clearTimeout(clustersTimer.current);
      clustersTimer.current = undefined;
    };
  }, [client, launchId, status]);

  return { detail, tests, streamState: state };
}
