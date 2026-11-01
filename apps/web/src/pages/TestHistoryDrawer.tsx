import { useQuery } from '@tanstack/react-query';
import { Clapperboard, Download, FileText, Image, Play, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { CopyButton } from '../components/CopyButton';
import { DurationDelta, SparklineHistory } from '../components/SparklineHistory';
import { StepWaterfall } from '../components/StepWaterfall';
import { TraceModal } from '../components/TraceModal';
import type { ArtifactInfo } from '../generated/ArtifactInfo';
import type { ExecutionDetail } from '../generated/ExecutionDetail';
import { useNow } from '../hooks/useNow';
import { Ansi } from '../lib/ansi';
import { api, queryKeys } from '../lib/api';
import { formatBytes, formatDateTime, formatDuration, formatPercent, relativeTime } from '../lib/format';
import { StatusBadge, StatusIcon } from '../lib/status';

type Tab = 'details' | 'history';

/**
 * Slide-over with everything about one test execution: attempts, labels, error,
 * steps, artifacts (with the embedded trace viewer), output and history.
 */
export function TestHistoryDrawer({
  executionId,
  projectSlug,
  onClose,
  onSelect,
}: {
  executionId: string;
  projectSlug: string;
  onClose: () => void;
  onSelect: (executionId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('details');
  const [trace, setTrace] = useState<ArtifactInfo | null>(null);
  const execution = useQuery({
    queryKey: queryKeys.execution(executionId),
    queryFn: () => api.execution(executionId),
    refetchInterval: (query) => (query.state.data?.test.status === 'running' ? 3_000 : false),
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !trace && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, trace]);

  const data = execution.data;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/25" onClick={onClose} aria-hidden />
      <aside
        className="fixed inset-y-0 right-0 z-40 flex w-full max-w-3xl flex-col border-l border-line bg-surface shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={data ? data.test.title : 'Test details'}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            {data ? (
              <>
                <p className="truncate text-xs text-ink-3">
                  {data.test.file_path}:{data.test.line}
                  {data.test.suite_path.length > 0 && ` › ${data.test.suite_path.join(' › ')}`}
                </p>
                <h2 className="mt-0.5 text-lg font-semibold text-ink">{data.test.title}</h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
                  <StatusBadge status={data.test.status} />
                  {data.test.browser_project && <span className="rounded border border-line px-1.5 text-xs">{data.test.browser_project}</span>}
                  <Duration detail={data} />
                  <span>Shard {data.test.shard_index} · Worker {data.test.parallel_index}</span>
                </div>
              </>
            ) : (
              <p className="text-sm text-ink-2">{execution.isError ? 'Could not load this test.' : 'Loading…'}</p>
            )}
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-ink-2 hover:bg-sunken hover:text-ink" aria-label="Close details">
            <X size={18} />
          </button>
        </div>

        {data && (
          <>
            <div className="flex items-center gap-1 border-b border-line px-5">
              {(['details', 'history'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`-mb-px border-b-2 px-3 py-2.5 text-sm ${tab === t ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}
                >
                  {t === 'details' ? 'Details' : 'History'}
                </button>
              ))}
              <div className="ml-auto flex items-center gap-2 py-2">
                {data.artifacts.some(isTrace) && (
                  <button
                    type="button"
                    onClick={() => setTrace(data.artifacts.find((a) => isTrace(a) && a.url) ?? null)}
                    disabled={!data.artifacts.some((a) => isTrace(a) && a.url)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    <Play size={13} aria-hidden /> Open trace
                  </button>
                )}
                <CopyButton text={data.retry_command} label="Copy retry command" />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {tab === 'details' ? (
                <Details detail={data} onSelect={onSelect} onTrace={setTrace} />
              ) : (
                <History projectSlug={projectSlug} detail={data} onSelect={onSelect} />
              )}
            </div>
          </>
        )}
      </aside>
      {trace?.url && data && <TraceModal traceUrl={trace.url} title={data.test.title} onClose={() => setTrace(null)} />}
    </>
  );
}

function isTrace(artifact: ArtifactInfo): boolean {
  return artifact.name === 'trace' || (artifact.content_type === 'application/zip' && /trace/i.test(artifact.file_name ?? ''));
}

function Duration({ detail }: { detail: ExecutionDetail }) {
  const running = detail.test.status === 'running';
  const now = useNow(1_000, running);
  const duration = running ? Math.max(0, now - Date.parse(detail.test.started_at)) : detail.test.duration_ms;
  return (
    <span className="inline-flex items-center gap-1.5 tabular">
      {formatDuration(duration)}
      {!running && <DurationDelta duration={detail.test.duration_ms} average={detail.test.avg_duration_ms} />}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

function Details({ detail, onSelect, onTrace }: { detail: ExecutionDetail; onSelect: (id: string) => void; onTrace: (a: ArtifactInfo) => void }) {
  const { test } = detail;
  const labels = (['severity', 'owner', 'epic', 'feature', 'story', 'issue'] as const).filter((key) => test.annotations[key]);
  const running = test.status === 'running';
  const now = useNow(1_000, running);
  const testDuration = running ? Math.max(0, now - Date.parse(test.started_at)) : (test.duration_ms ?? 0);
  return (
    <>
      {detail.attempts.length > 1 && (
        <Section title="Attempts">
          <div className="flex flex-wrap gap-2">
            {detail.attempts.map((attempt) => (
              <button
                key={attempt.execution_id}
                type="button"
                onClick={() => onSelect(attempt.execution_id)}
                aria-current={attempt.execution_id === test.execution_id}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm ${
                  attempt.execution_id === test.execution_id ? 'border-accent bg-accent-wash text-ink' : 'border-line text-ink-2 hover:bg-sunken'
                }`}
              >
                <StatusIcon status={attempt.status} size={14} />
                {attempt.retry_attempt === 0 ? 'First run' : `Retry ${attempt.retry_attempt}`}
                <span className="tabular text-xs text-ink-3">{formatDuration(attempt.duration_ms)}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      {(labels.length > 0 || test.annotations.tags.length > 0) && (
        <Section title="Labels">
          <dl className="flex flex-wrap gap-2 text-sm">
            {labels.map((key) => (
              <div key={key} className="rounded-lg border border-line px-2.5 py-1">
                <dt className="inline text-ink-3">{key} </dt>
                <dd className="inline font-medium text-ink">{test.annotations[key]}</dd>
              </div>
            ))}
            {test.annotations.tags.map((tag) => (
              <span key={tag} className="rounded-lg bg-sunken px-2.5 py-1 text-ink-2">
                {tag}
              </span>
            ))}
          </dl>
        </Section>
      )}

      {test.error_message && (
        <Section title="Error">
          <Ansi text={test.error_message} className="max-h-72 overflow-auto rounded-lg border border-failed/30 bg-failed/5 p-3 font-mono text-xs whitespace-pre-wrap text-ink" />
          {detail.error_snippet && (
            <Ansi text={detail.error_snippet} className="mt-2 overflow-auto rounded-lg bg-sunken p-3 font-mono text-xs text-ink" />
          )}
          {detail.error_stack && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-ink-2">Stack trace</summary>
              <Ansi text={detail.error_stack} className="mt-1 overflow-auto rounded-lg bg-sunken p-3 font-mono text-xs whitespace-pre-wrap text-ink-2" />
            </details>
          )}
        </Section>
      )}

      <Section title="Steps">
        <StepWaterfall steps={detail.steps} testStart={test.started_at} testDuration={testDuration} />
      </Section>

      {detail.artifacts.length > 0 && (
        <Section title="Attachments">
          <Artifacts artifacts={detail.artifacts} onTrace={onTrace} />
        </Section>
      )}

      {(detail.stdout.length > 0 || detail.stderr.length > 0) && (
        <Section title="Console output">
          {detail.stdout.length > 0 && <Ansi text={detail.stdout.join('')} className="max-h-60 overflow-auto rounded-lg bg-sunken p-3 font-mono text-xs whitespace-pre-wrap text-ink" />}
          {detail.stderr.length > 0 && (
            <Ansi text={detail.stderr.join('')} className="mt-2 max-h-60 overflow-auto rounded-lg border border-failed/30 bg-sunken p-3 font-mono text-xs whitespace-pre-wrap text-ink" />
          )}
        </Section>
      )}
    </>
  );
}

function Artifacts({ artifacts, onTrace }: { artifacts: ArtifactInfo[]; onTrace: (a: ArtifactInfo) => void }) {
  const images = artifacts.filter((a) => a.content_type.startsWith('image/'));
  const videos = artifacts.filter((a) => a.content_type.startsWith('video/'));
  const others = artifacts.filter((a) => !images.includes(a) && !videos.includes(a));
  return (
    <div className="space-y-3">
      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((image) =>
            image.url ? (
              <a key={image.id} href={image.url} target="_blank" rel="noreferrer" className="group block overflow-hidden rounded-lg border border-line">
                <img src={image.url} alt={image.name} loading="lazy" className="aspect-video w-full object-cover object-top transition-transform group-hover:scale-[1.02]" />
                <span className="flex items-center gap-1.5 px-2 py-1 text-xs text-ink-2">
                  <Image size={12} aria-hidden /> {image.name}
                </span>
              </a>
            ) : (
              <Pending key={image.id} artifact={image} />
            ),
          )}
        </div>
      )}
      {videos.map((video) =>
        video.url ? (
          <figure key={video.id} className="overflow-hidden rounded-lg border border-line">
            <video src={video.url} controls preload="metadata" className="w-full bg-black" />
            <figcaption className="flex items-center gap-1.5 px-2 py-1 text-xs text-ink-2">
              <Clapperboard size={12} aria-hidden /> {video.name}
            </figcaption>
          </figure>
        ) : (
          <Pending key={video.id} artifact={video} />
        ),
      )}
      {others.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {others.map((artifact) => (
            <li key={artifact.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <FileText size={15} className="text-ink-3" aria-hidden />
              <span className="truncate text-ink">{artifact.file_name ?? artifact.name}</span>
              <span className="text-xs text-ink-3">{formatBytes(artifact.size_bytes)}</span>
              <span className="ml-auto flex items-center gap-2">
                {!artifact.uploaded && <span className="text-xs text-ink-3">Uploading…</span>}
                {artifact.url && isTrace(artifact) && (
                  <button type="button" onClick={() => onTrace(artifact)} className="text-xs font-medium text-accent hover:underline">
                    View trace
                  </button>
                )}
                {artifact.url && (
                  <a href={artifact.url} className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink" download={artifact.file_name ?? undefined}>
                    <Download size={13} aria-hidden /> Download
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Pending({ artifact }: { artifact: ArtifactInfo }) {
  return (
    <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-line text-xs text-ink-3">
      Uploading {artifact.name}…
    </div>
  );
}

function History({ projectSlug, detail, onSelect }: { projectSlug: string; detail: ExecutionDetail; onSelect: (id: string) => void }) {
  const history = useQuery({
    queryKey: queryKeys.history(projectSlug, detail.test.fingerprint),
    queryFn: () => api.history(projectSlug, detail.test.fingerprint),
  });
  if (!history.data) return <p className="text-sm text-ink-2">{history.isError ? 'Could not load history.' : 'Loading history…'}</p>;
  const { entries } = history.data;
  return (
    <>
      <div className="mb-5 grid grid-cols-3 gap-3">
        <Stat label="Pass rate" value={formatPercent(history.data.pass_rate)} />
        <Stat label="Flaky rate" value={formatPercent(history.data.flaky_rate)} />
        <Stat label="Average duration" value={formatDuration(history.data.avg_duration_ms)} />
      </div>
      <div className="mb-4">
        <SparklineHistory
          size={12}
          history={entries.slice(0, 30).map((e) => ({ launch_id: e.launch_id, execution_id: e.execution_id, status: e.status, duration_ms: e.duration_ms }))}
        />
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-3">
            <th className="py-2 font-medium">Result</th>
            <th className="py-2 font-medium">Launch</th>
            <th className="py-2 font-medium">When</th>
            <th className="py-2 text-right font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.execution_id}
              onClick={() => onSelect(entry.execution_id)}
              className={`cursor-pointer border-b border-line last:border-0 hover:bg-sunken ${entry.execution_id === detail.test.execution_id ? 'bg-accent-wash' : ''}`}
            >
              <td className="py-2">
                <StatusBadge status={entry.status} />
              </td>
              <td className="py-2 text-ink-2">
                {entry.build_number ? `#${entry.build_number}` : entry.launch_id.slice(0, 8)}
                {entry.branch && <span className="text-ink-3"> · {entry.branch}</span>}
              </td>
              <td className="py-2 text-ink-2" title={formatDateTime(entry.started_at)}>
                {relativeTime(entry.started_at)}
              </td>
              <td className="tabular py-2 text-right text-ink-2">{formatDuration(entry.duration_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <p className="text-xs text-ink-3">{label}</p>
      <p className="text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}
