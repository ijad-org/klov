import { GitBranch, GitCommitHorizontal, Layers, Timer } from 'lucide-react';
import { useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router';

import { CopyButton } from '../components/CopyButton';
import { FailureClusters } from '../components/FailureClusters';
import { LiveTestTree } from '../components/LiveTestTree';
import { ProgressBar } from '../components/ProgressBar';
import { Card, EmptyState, Shell } from '../components/Shell';
import { WorkerSwimlanes } from '../components/WorkerSwimlanes';
import type { LaunchSummary } from '../generated/LaunchSummary';
import { type StreamState, useLaunchStream } from '../hooks/useLaunchStream';
import { useNow } from '../hooks/useNow';
import { formatDateTime, formatDuration, relativeTime, shortSha } from '../lib/format';
import { StatusBadge } from '../lib/status';
import { TestHistoryDrawer } from './TestHistoryDrawer';

export function launchTitle(launch: Pick<LaunchSummary, 'build_number' | 'ci_run_id'>): string {
  return launch.build_number ? `Build #${launch.build_number}` : launch.ci_run_id.length > 24 ? `${launch.ci_run_id.slice(0, 8)}…` : launch.ci_run_id;
}

export function LaunchDashboard() {
  const { slug = '', launchId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const selected = params.get('test') ?? undefined;
  const { detail, tests, streamState } = useLaunchStream(launchId);

  const select = useCallback(
    (executionId: string) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set('test', executionId);
          return next;
        },
        { replace: !!selected },
      ),
    [setParams, selected],
  );
  const close = useCallback(
    () =>
      setParams((current) => {
        const next = new URLSearchParams(current);
        next.delete('test');
        return next;
      }),
    [setParams],
  );

  const launch = detail.data?.launch;
  return (
    <Shell crumbs={[{ label: slug, to: `/projects/${slug}` }, { label: launch ? launchTitle(launch) : 'Launch' }]}>
      {detail.isError ? (
        <Card>
          <EmptyState title="This launch could not be loaded">{(detail.error as Error).message}</EmptyState>
        </Card>
      ) : !launch || !detail.data ? (
        <p className="text-sm text-ink-2">Loading launch…</p>
      ) : (
        <div className="space-y-4">
          <LaunchHeader launch={launch} streamState={streamState} retryCommand={detail.data.retry_command} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
            <Card className="flex h-[calc(100vh-15rem)] min-h-[480px] flex-col overflow-hidden" title="Tests">
              {tests.data ? (
                <LiveTestTree rows={tests.data} selected={selected} onSelect={select} />
              ) : (
                <p className="p-4 text-sm text-ink-2">Loading tests…</p>
              )}
            </Card>
            <div className="space-y-4">
              <Card title="Workers">
                <WorkerSwimlanes workers={detail.data.workers} live={launch.status === 'running'} onOpen={select} />
              </Card>
              <Card
                title={
                  <span>
                    Failure clusters <span className="font-normal text-ink-3">· {detail.data.clusters.length}</span>
                  </span>
                }
              >
                <FailureClusters key={launch.id} clusters={detail.data.clusters} onOpen={select} />
              </Card>
            </div>
          </div>
        </div>
      )}
      {selected && <TestHistoryDrawer executionId={selected} projectSlug={slug} onClose={close} onSelect={select} />}
    </Shell>
  );
}

function LaunchHeader({ launch, streamState, retryCommand }: { launch: LaunchSummary; streamState: StreamState; retryCommand: string | null }) {
  const running = launch.status === 'running';
  const now = useNow(1_000, running);
  const duration = running ? Math.max(0, now - Date.parse(launch.started_at)) : launch.duration_ms;
  return (
    <Card>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-semibold text-ink">{launchTitle(launch)}</h1>
              <StatusBadge status={launch.status === 'interrupted' ? 'interrupted' : launch.status} />
              <StreamIndicator state={streamState} running={running} />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-2">
              {launch.branch && (
                <span className="inline-flex items-center gap-1">
                  <GitBranch size={14} aria-hidden /> {launch.branch}
                </span>
              )}
              {launch.commit_sha && (
                <span className="inline-flex items-center gap-1 font-mono text-xs">
                  <GitCommitHorizontal size={14} aria-hidden /> {shortSha(launch.commit_sha)}
                </span>
              )}
              <span title={formatDateTime(launch.started_at)}>Started {relativeTime(launch.started_at, now)}</span>
              <span className="inline-flex items-center gap-1 tabular">
                <Timer size={14} aria-hidden /> {formatDuration(duration)}
              </span>
              {launch.total_shards > 1 && (
                <span className="inline-flex items-center gap-1">
                  <Layers size={14} aria-hidden /> {launch.completed_shards}/{launch.total_shards} shards done
                </span>
              )}
            </div>
          </div>
          {retryCommand && (
            <div className="ml-auto">
              <CopyButton text={retryCommand} label={`Copy retry command for ${launch.failed_count} failed`} />
            </div>
          )}
        </div>
        <ProgressBar
          counts={{
            total: launch.total_tests,
            passed: launch.passed_count,
            failed: launch.failed_count,
            flaky: launch.flaky_count,
            skipped: launch.skipped_count,
            running: launch.running_count,
          }}
        />
      </div>
    </Card>
  );
}

function StreamIndicator({ state, running }: { state: StreamState; running: boolean }) {
  if (!running) return null;
  const label = state === 'live' ? 'Live' : state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs text-ink-2" role="status">
      <span className={`size-2 rounded-full ${state === 'live' ? 'bg-running live-pulse' : 'bg-flaky'}`} aria-hidden />
      {label}
    </span>
  );
}
