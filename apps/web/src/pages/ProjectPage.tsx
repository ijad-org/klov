import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';

import { ProgressBar } from '../components/ProgressBar';
import { Card, EmptyState, Shell } from '../components/Shell';
import { TrendChart } from '../components/TrendChart';
import type { LaunchSummary } from '../generated/LaunchSummary';
import { api, queryKeys } from '../lib/api';
import { formatDateTime, formatDuration, formatPercent, relativeTime, shortSha } from '../lib/format';
import { StatusBadge } from '../lib/status';
import { launchTitle } from './LaunchDashboard';

function passRate(launch: LaunchSummary): number | null {
  const executed = launch.passed_count + launch.flaky_count + launch.failed_count;
  return executed === 0 ? null : (launch.passed_count + launch.flaky_count) / executed;
}

export function ProjectPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const launches = useQuery({ queryKey: queryKeys.launches(slug), queryFn: () => api.launches(slug), refetchInterval: 5_000 });
  const analytics = useQuery({ queryKey: queryKeys.analytics(slug), queryFn: () => api.analytics(slug), refetchInterval: 10_000 });

  const finished = launches.data?.filter((l) => l.status !== 'running') ?? [];
  const latest = finished[0];
  const previous = finished[1];
  const latestRate = latest ? passRate(latest) : null;
  const previousRate = previous ? passRate(previous) : null;
  const delta = latestRate != null && previousRate != null ? latestRate - previousRate : null;

  return (
    <Shell crumbs={[{ label: slug }]}>
      {launches.isError ? (
        <Card>
          <EmptyState title="Project not found">{(launches.error as Error).message}</EmptyState>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Tile label="Pass rate, latest launch" value={formatPercent(latestRate)}>
              {delta != null && Math.abs(delta) >= 0.001 && (
                <span className={`text-xs font-medium ${delta > 0 ? 'text-success-text' : 'text-ink-2'}`}>
                  {delta > 0 ? '▲' : '▼'} {formatPercent(Math.abs(delta))} vs previous
                </span>
              )}
            </Tile>
            <Tile label="Tests, latest launch" value={latest ? String(latest.total_tests) : '–'} />
            <Tile label="Flaky tests, last 30 launches" value={analytics.data ? String(analytics.data.flaky_tests.length) : '–'} />
            <Tile label="Duration, latest launch" value={formatDuration(latest?.duration_ms)} />
          </div>

          <Card title="Results by launch">
            <div className="p-4">
              {analytics.data ? (
                <TrendChart points={analytics.data.trend} onSelect={(id) => navigate(`/projects/${slug}/launches/${id}`)} />
              ) : (
                <p className="text-sm text-ink-2">Loading…</p>
              )}
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Card title="Launches">
              {launches.data && launches.data.length === 0 ? (
                <EmptyState title="No launches yet">Run your Playwright suite with the KlovPlay reporter to see results here.</EmptyState>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs text-ink-3">
                        <th className="px-4 py-2 font-medium">Launch</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                        <th className="px-4 py-2 font-medium">Results</th>
                        <th className="px-4 py-2 font-medium">Started</th>
                        <th className="px-4 py-2 text-right font-medium">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {launches.data?.map((launch) => (
                        <tr key={launch.id} className="border-b border-line last:border-0 hover:bg-sunken">
                          <td className="px-4 py-2.5">
                            <Link to={`/projects/${slug}/launches/${launch.id}`} className="font-medium text-ink hover:underline">
                              {launchTitle(launch)}
                            </Link>
                            <p className="text-xs text-ink-3">
                              {launch.branch ?? 'no branch'}
                              {launch.commit_sha && <span className="font-mono"> · {shortSha(launch.commit_sha)}</span>}
                            </p>
                          </td>
                          <td className="px-4 py-2.5">
                            <StatusBadge status={launch.status} />
                          </td>
                          <td className="w-56 px-4 py-2.5">
                            <ProgressBar
                              legend={false}
                              height={8}
                              counts={{
                                total: launch.total_tests,
                                passed: launch.passed_count,
                                failed: launch.failed_count,
                                flaky: launch.flaky_count,
                                skipped: launch.skipped_count,
                                running: launch.running_count,
                              }}
                            />
                            <p className="tabular mt-1 text-xs text-ink-3">
                              {launch.failed_count} failed · {launch.flaky_count} flaky · {launch.total_tests} total
                            </p>
                          </td>
                          <td className="px-4 py-2.5 text-ink-2" title={formatDateTime(launch.started_at)}>
                            {relativeTime(launch.started_at)}
                          </td>
                          <td className="tabular px-4 py-2.5 text-right text-ink-2">{formatDuration(launch.duration_ms)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card title="Flakiest tests">
              {analytics.data && analytics.data.flaky_tests.length === 0 ? (
                <EmptyState title="No flaky tests">Tests that pass only after a retry show up here.</EmptyState>
              ) : (
                <ul className="divide-y divide-line">
                  {analytics.data?.flaky_tests.map((test) => (
                    <li key={test.fingerprint} className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-ink">{test.title}</p>
                          <p className="truncate text-xs text-ink-3">
                            {test.file_path} · {test.browser_project}
                          </p>
                        </div>
                        <div className="w-28 shrink-0 text-right">
                          <p className="tabular text-sm font-semibold text-ink">{formatPercent(test.flaky_rate)}</p>
                          <p className="tabular text-xs text-ink-3">
                            flaky in {test.flaky} of {test.runs}
                          </p>
                        </div>
                      </div>
                      <div className="mt-1.5 h-1 rounded-full bg-flaky/20" aria-hidden>
                        <div className="h-full rounded-full bg-flaky" style={{ width: `${test.flaky_rate * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </Shell>
  );
}

function Tile({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <p className="text-xs text-ink-2">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
      {children}
    </div>
  );
}
