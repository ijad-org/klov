import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { ProgressBar } from '../components/ProgressBar';
import { Card, EmptyState, Shell } from '../components/Shell';
import { Tip } from '../components/Tip';
import type { ProjectSummary } from '../generated/ProjectSummary';
import { api, queryKeys } from '../lib/api';
import { formatDuration, relativeTime } from '../lib/format';
import { StatusBadge, statusMeta } from '../lib/status';
import { launchTitle } from './LaunchDashboard';

export function ProjectsOverview() {
  const projects = useQuery({ queryKey: queryKeys.projects, queryFn: api.projects, refetchInterval: 5_000 });
  return (
    <Shell>
      <div className="mb-5 flex items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Projects</h1>
          <p className="text-sm text-ink-2">Live and recent Playwright launches across your projects.</p>
        </div>
      </div>
      {projects.isError ? (
        <Card>
          <EmptyState title="Could not reach the KlovPlay server">{(projects.error as Error).message}</EmptyState>
        </Card>
      ) : !projects.data ? (
        <p className="text-sm text-ink-2">Loading…</p>
      ) : projects.data.length === 0 ? (
        <GettingStarted />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.data.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </Shell>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const latest = project.latest_launch;
  const running = latest?.status === 'running';
  return (
    <Link
      to={`/projects/${project.slug}`}
      className="group block rounded-xl border border-line bg-surface p-4 transition-colors hover:border-accent/50"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-ink group-hover:underline">{project.name}</h2>
          <p className="text-xs text-ink-3">
            {project.slug} · {project.launch_count} {project.launch_count === 1 ? 'launch' : 'launches'}
          </p>
        </div>
        {running && (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs text-ink-2">
            <span className="size-2 rounded-full bg-running live-pulse" aria-hidden /> Running
          </span>
        )}
      </div>
      {latest ? (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <StatusBadge status={latest.status} />
            <span className="text-ink-3">·</span>
            <span className="truncate text-ink-2">{launchTitle(latest)}</span>
            <span className="ml-auto shrink-0 text-xs text-ink-3">
              {relativeTime(latest.started_at)} · {formatDuration(latest.duration_ms)}
            </span>
          </div>
          <ProgressBar
            legend={false}
            height={8}
            counts={{
              total: latest.total_tests,
              passed: latest.passed_count,
              failed: latest.failed_count,
              flaky: latest.flaky_count,
              skipped: latest.skipped_count,
              running: latest.running_count,
            }}
          />
          <div className="flex items-center gap-3 text-xs text-ink-2">
            <span className="tabular">
              <span className="font-semibold text-ink">{latest.failed_count}</span> failed ·{' '}
              <span className="font-semibold text-ink">{latest.flaky_count}</span> flaky ·{' '}
              <span className="font-semibold text-ink">{latest.total_tests}</span> tests
            </span>
            <span className="ml-auto inline-flex items-center gap-1" aria-label="Recent launches, oldest first">
              {[...project.recent].reverse().map((launch) => (
                <Tip key={launch.id} content={`${launchTitle(launch)} · ${statusMeta(launch.status).label}`} align="end">
                  <span className="block size-2.5 rounded-sm" style={{ background: statusMeta(launch.status).color }} />
                </Tip>
              ))}
            </span>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-2">No launches yet.</p>
      )}
    </Link>
  );
}

function GettingStarted() {
  return (
    <Card title="Get started">
      <div className="space-y-4 p-4 text-sm text-ink-2">
        <p>1. Create a project and copy its API key:</p>
        <pre className="overflow-auto rounded-lg bg-sunken p-3 font-mono text-xs text-ink">
          {`curl -X POST $KLOVPLAY_URL/api/v1/projects \\
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \\
  -d '{"slug": "web", "name": "Web app"}'`}
        </pre>
        <p>2. Add the reporter to playwright.config.ts:</p>
        <pre className="overflow-auto rounded-lg bg-sunken p-3 font-mono text-xs text-ink">
          {`reporter: [
  ['list'],
  ['@klovplay/playwright-reporter', { serverUrl: 'http://localhost:8080', project: 'web' }],
],`}
        </pre>
        <p>
          3. Run <code className="rounded bg-sunken px-1 font-mono text-xs text-ink">KLOVPLAY_API_KEY=kp_… npx playwright test</code> and watch results
          arrive here live.
        </p>
      </div>
    </Card>
  );
}
