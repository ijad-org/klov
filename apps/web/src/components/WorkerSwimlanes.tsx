import { TriangleAlert } from 'lucide-react';

import type { WorkerState } from '../generated/WorkerState';
import { useNow } from '../hooks/useNow';
import { formatDuration } from '../lib/format';

/** Steps running longer than this are highlighted as possibly hung. */
export const SLOW_STEP_MS = 15_000;

/**
 * One track per worker (shard × parallel slot): the test it is running, its current
 * step and a live timer. The track fills toward the slow-step threshold and turns
 * amber past it, so hung workers stand out.
 */
export function WorkerSwimlanes({ workers, live, onOpen }: { workers: WorkerState[]; live: boolean; onOpen: (executionId: string) => void }) {
  const now = useNow(500, live);
  const busy = workers.filter((w) => w.status === 'running').length;
  if (workers.length === 0) {
    return <p className="px-4 py-6 text-sm text-ink-2">Workers appear here as soon as the first test starts.</p>;
  }
  return (
    <div>
      <p className="px-4 pt-3 text-xs text-ink-2">
        <span className="tabular font-semibold text-ink">{busy}</span> of {workers.length} workers busy
      </p>
      <ul className="divide-y divide-line">
        {workers.map((worker) => {
          const running = live && worker.status === 'running';
          const elapsed = Math.max(0, now - Date.parse(worker.started_at));
          const slow = running && elapsed > SLOW_STEP_MS;
          const fill = Math.min(1, elapsed / SLOW_STEP_MS);
          return (
            <li key={worker.worker_id} className={`px-4 py-2.5 ${running ? '' : 'opacity-60'}`}>
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={`size-2 shrink-0 rounded-full ${running ? 'bg-running live-pulse' : 'bg-skipped'}`}
                  aria-hidden
                />
                <span className="tabular font-medium text-ink-2">
                  Shard {worker.shard_index} · Worker {worker.parallel_index}
                </span>
                <span className="ml-auto inline-flex items-center gap-1 tabular text-ink-2">
                  {slow && <TriangleAlert size={13} className="text-flaky" aria-hidden />}
                  {running ? (
                    <span className={slow ? 'font-semibold text-ink' : ''}>
                      {formatDuration(elapsed)}
                      {slow && ' · slow step'}
                    </span>
                  ) : (
                    'idle'
                  )}
                </span>
              </div>
              {worker.test_title && worker.execution_id ? (
                <button
                  type="button"
                  onClick={() => onOpen(worker.execution_id!)}
                  className="mt-1 block w-full truncate text-left text-sm text-ink hover:underline"
                  title={worker.test_title}
                >
                  {worker.test_title}
                </button>
              ) : (
                <p className="mt-1 text-sm text-ink-3">Waiting for a test</p>
              )}
              {running && (
                <>
                  <p className="truncate text-xs text-ink-2" title={worker.current_step ?? undefined}>
                    {worker.current_step ?? 'Starting…'}
                  </p>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-sunken" aria-hidden>
                    <div
                      className="h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${fill * 100}%`, background: slow ? 'var(--status-flaky)' : 'var(--status-running)' }}
                    />
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
