import { StatusIcon } from '../lib/status';
import { Tip } from './Tip';

export interface Counts {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  running: number;
}

/** Stacking order chosen so neighbouring colors stay distinguishable (failed → flaky → passed → skipped). */
const SEGMENTS: { key: keyof Omit<Counts, 'total'>; label: string; color: string }[] = [
  { key: 'failed', label: 'Failed', color: 'var(--status-failed)' },
  { key: 'flaky', label: 'Flaky', color: 'var(--status-flaky)' },
  { key: 'passed', label: 'Passed', color: 'var(--status-passed)' },
  { key: 'skipped', label: 'Skipped', color: 'var(--status-skipped)' },
  { key: 'running', label: 'Running', color: 'var(--status-running)' },
];

/** Stacked launch progress: finished tests by status, then running, then the queued remainder as track. */
export function ProgressBar({ counts, height = 10, legend = true }: { counts: Counts; height?: number; legend?: boolean }) {
  const done = SEGMENTS.reduce((sum, s) => sum + counts[s.key], 0);
  const total = Math.max(counts.total, done, 1);
  const queued = Math.max(0, counts.total - done);
  return (
    <div>
      <div
        className="flex w-full gap-[2px] overflow-hidden rounded bg-sunken"
        style={{ height }}
        role="img"
        aria-label={SEGMENTS.map((s) => `${counts[s.key]} ${s.label.toLowerCase()}`).join(', ') + `, ${queued} queued`}
      >
        {SEGMENTS.filter((s) => counts[s.key] > 0).map((s) => (
          <Tip
            key={s.key}
            content={`${counts[s.key]} ${s.label.toLowerCase()}`}
            className="h-full transition-[width] duration-500"
            style={{ width: `${(counts[s.key] / total) * 100}%`, minWidth: 3 }}
          >
            <span
              tabIndex={0}
              aria-label={`${counts[s.key]} ${s.label.toLowerCase()}`}
              className="block h-full w-full hover:brightness-110"
              style={{ background: s.color }}
            />
          </Tip>
        ))}
      </div>
      {legend && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
          {SEGMENTS.filter((s) => s.key !== 'running' || counts.running > 0).map((s) => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <StatusIcon status={s.key} size={14} />
              <span className="tabular font-semibold text-ink">{counts[s.key]}</span> {s.label.toLowerCase()}
            </li>
          ))}
          {queued > 0 && (
            <li className="inline-flex items-center gap-1.5">
              <span className="size-3 rounded-sm border border-line bg-sunken" aria-hidden />
              <span className="tabular font-semibold text-ink">{queued}</span> queued
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
