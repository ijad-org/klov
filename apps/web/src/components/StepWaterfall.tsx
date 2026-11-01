import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import type { StepNode } from '../generated/StepNode';
import { Ansi } from '../lib/ansi';
import { formatDuration } from '../lib/format';
import { StatusIcon } from '../lib/status';

const COLLAPSED_BY_DEFAULT = new Set(['hook', 'fixture']);

/**
 * Nested steps with a waterfall bar per step, positioned on the test's own timeline,
 * so slow actions and gaps stand out at a glance.
 */
export function StepWaterfall({ steps, testStart, testDuration }: { steps: StepNode[]; testStart: string; testDuration: number }) {
  if (steps.length === 0) return <p className="text-sm text-ink-2">No steps were reported for this attempt.</p>;
  const start = Date.parse(testStart);
  const total = Math.max(testDuration, 1);
  return (
    <div className="rounded-lg border border-line">
      <div className="flex border-b border-line px-3 py-1.5 text-[11px] uppercase tracking-wide text-ink-3">
        <span className="flex-1">Step</span>
        <span className="hidden w-[38%] sm:block">Timeline</span>
        <span className="w-16 text-right">Duration</span>
      </div>
      <ul>
        {steps.map((step) => (
          <StepRow key={step.id} step={step} depth={0} start={start} total={total} />
        ))}
      </ul>
    </div>
  );
}

function StepRow({ step, depth, start, total }: { step: StepNode; depth: number; start: number; total: number }) {
  const [open, setOpen] = useState(!COLLAPSED_BY_DEFAULT.has(step.category) && depth < 3);
  const hasChildren = step.children.length > 0;
  const offset = Math.max(0, Date.parse(step.started_at) - start);
  const left = Math.min(1, offset / total);
  const width = Math.max(0.004, Math.min(1 - left, (step.duration_ms ?? 0) / total));
  const failed = step.status === 'failed';
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-1.5 text-sm" style={{ paddingLeft: 12 + depth * 16 }}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          disabled={!hasChildren}
          aria-expanded={hasChildren ? open : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
        >
          <ChevronRight size={13} className={`shrink-0 text-ink-3 transition-transform ${hasChildren ? '' : 'invisible'} ${open ? 'rotate-90' : ''}`} aria-hidden />
          <StatusIcon status={step.status === 'running' ? 'running' : step.status === 'interrupted' ? 'interrupted' : failed ? 'failed' : 'passed'} size={13} />
          <span className={`truncate ${failed ? 'font-medium text-ink' : 'text-ink'}`}>{step.title}</span>
          <span className="shrink-0 rounded bg-sunken px-1 text-[10px] text-ink-3">{step.category}</span>
        </button>
        <span className="relative hidden h-2 w-[38%] rounded-sm bg-sunken sm:block" aria-hidden>
          <span
            className="absolute inset-y-0 rounded-sm"
            style={{
              left: `${left * 100}%`,
              width: `${width * 100}%`,
              background: failed ? 'var(--status-failed)' : step.category === 'test.step' ? 'var(--accent)' : 'var(--status-skipped)',
            }}
          />
        </span>
        <span className="tabular w-16 shrink-0 text-right text-xs text-ink-2">{formatDuration(step.duration_ms)}</span>
      </div>
      {failed && step.error_message && (
        <Ansi text={step.error_message} className="mx-3 mb-2 max-h-40 overflow-auto rounded bg-sunken p-2 font-mono text-xs whitespace-pre-wrap text-ink" />
      )}
      {open && hasChildren && (
        <ul>
          {step.children.map((child) => (
            <StepRow key={child.id} step={child} depth={depth + 1} start={start} total={total} />
          ))}
        </ul>
      )}
    </li>
  );
}
