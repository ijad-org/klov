import type { HistoryDot } from '../generated/HistoryDot';
import { formatDuration } from '../lib/format';
import { statusMeta } from '../lib/status';
import { Tip } from './Tip';

/**
 * The test's last results, oldest left to newest right, ending with the current run.
 * Each dot carries its status in a tooltip; the strip is labelled for screen readers.
 */
export function SparklineHistory({ history, current, size = 8 }: { history: HistoryDot[]; current?: string; size?: number }) {
  const dots = [...history].reverse();
  const slots = Math.max(0, 10 - dots.length);
  const summary = dots.map((d) => statusMeta(d.status).label.toLowerCase()).join(', ');
  return (
    <span className="inline-flex items-center gap-[3px]" aria-label={summary ? `Previous runs: ${summary}` : 'No previous runs'}>
      {Array.from({ length: slots }, (_, i) => (
        <span key={`empty-${i}`} className="rounded-full border border-line" style={{ width: size, height: size }} aria-hidden />
      ))}
      {dots.map((dot) => (
        <Tip key={dot.execution_id} content={`${statusMeta(dot.status).label} · ${formatDuration(dot.duration_ms)}`}>
          <span className="block rounded-full" style={{ width: size, height: size, background: statusMeta(dot.status).color }} />
        </Tip>
      ))}
      {current && (
        <span
          className="ml-0.5 rounded-full ring-2 ring-surface outline outline-1 outline-ink-3"
          style={{ width: size + 2, height: size + 2, background: statusMeta(current).color }}
          title={`This run: ${statusMeta(current).label}`}
          aria-hidden
        />
      )}
    </span>
  );
}

/** "+1.4s" when slower than the recent average by more than 20%, "-0.8s" when clearly faster. */
export function DurationDelta({ duration, average }: { duration: number | null; average: number | null }) {
  if (duration == null || average == null || average <= 0) return null;
  const delta = duration - average;
  if (Math.abs(delta) < 250 || Math.abs(delta) / average < 0.2) return null;
  const slower = delta > 0;
  return (
    <Tip content={`Average of previous passing runs: ${formatDuration(average)}`} align="end">
      <span
        className={`tabular rounded px-1.5 py-0.5 text-[11px] font-semibold ${
          slower ? 'bg-flaky/15 text-ink' : 'bg-passed/12 text-success-text'
        }`}
      >
        {slower ? '+' : '−'}
        {formatDuration(Math.abs(delta))}
      </span>
    </Tip>
  );
}
