import { CircleCheck, CircleMinus, CircleX, LoaderCircle, OctagonAlert, TimerOff, TriangleAlert } from 'lucide-react';
import type { ComponentType } from 'react';

type Icon = ComponentType<{ className?: string; size?: number; 'aria-hidden'?: boolean }>;

interface StatusMeta {
  label: string;
  /** Tailwind text-color class for the icon; labels always stay in ink colors. */
  tone: string;
  /** CSS variable for marks (bars, dots). */
  color: string;
  Icon: Icon;
  spin?: boolean;
}

const META: Record<string, StatusMeta> = {
  passed: { label: 'Passed', tone: 'text-passed', color: 'var(--status-passed)', Icon: CircleCheck },
  failed: { label: 'Failed', tone: 'text-failed', color: 'var(--status-failed)', Icon: CircleX },
  timedOut: { label: 'Timed out', tone: 'text-broken', color: 'var(--status-broken)', Icon: TimerOff },
  interrupted: { label: 'Interrupted', tone: 'text-broken', color: 'var(--status-broken)', Icon: OctagonAlert },
  flaky: { label: 'Flaky', tone: 'text-flaky', color: 'var(--status-flaky)', Icon: TriangleAlert },
  skipped: { label: 'Skipped', tone: 'text-skipped', color: 'var(--status-skipped)', Icon: CircleMinus },
  running: { label: 'Running', tone: 'text-running', color: 'var(--status-running)', Icon: LoaderCircle, spin: true },
};

export function statusMeta(status: string): StatusMeta {
  return META[status] ?? META.skipped;
}

/** Status groups used by filters and counters: failed covers timed out and interrupted. */
export type StatusGroup = 'failed' | 'flaky' | 'passed' | 'skipped' | 'running';

export function statusGroup(status: string): StatusGroup {
  if (status === 'failed' || status === 'timedOut' || status === 'interrupted') return 'failed';
  if (status === 'flaky' || status === 'passed' || status === 'skipped' || status === 'running') return status;
  return 'skipped';
}

/** Worst first, used to roll a group of tests up to one status. */
const SEVERITY = ['failed', 'timedOut', 'interrupted', 'running', 'flaky', 'passed', 'skipped'];

export function worstStatus(statuses: Iterable<string>): string {
  let best = SEVERITY.length;
  for (const status of statuses) best = Math.min(best, SEVERITY.indexOf(status) === -1 ? SEVERITY.length : SEVERITY.indexOf(status));
  return SEVERITY[best] ?? 'skipped';
}

export function StatusIcon({ status, size = 16, className = '' }: { status: string; size?: number; className?: string }) {
  const meta = statusMeta(status);
  return (
    <meta.Icon
      size={size}
      aria-hidden
      className={`${meta.tone} shrink-0 ${meta.spin ? 'animate-spin [animation-duration:2s]' : ''} ${className}`}
    />
  );
}

export function StatusBadge({ status, className = '' }: { status: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium text-ink ${className}`}>
      <StatusIcon status={status} />
      {statusMeta(status).label}
    </span>
  );
}
