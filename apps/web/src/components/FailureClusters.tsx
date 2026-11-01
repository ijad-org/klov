import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import type { FailureCluster } from '../generated/FailureCluster';
import { Ansi } from '../lib/ansi';
import { StatusIcon } from '../lib/status';
import { CopyButton } from './CopyButton';

/**
 * Failures grouped by root cause (same normalized error), largest group first,
 * so 40 tests broken by one 502 read as one problem instead of 40.
 */
export function FailureClusters({ clusters, onOpen }: { clusters: FailureCluster[]; onOpen: (executionId: string) => void }) {
  const [open, setOpen] = useState<string | null>(clusters[0]?.error_cluster_hash ?? null);
  if (clusters.length === 0) {
    return <p className="px-4 py-6 text-sm text-ink-2">No failures so far.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {clusters.map((cluster) => {
        const expanded = open === cluster.error_cluster_hash;
        return (
          <li key={cluster.error_cluster_hash}>
            <button
              type="button"
              onClick={() => setOpen(expanded ? null : cluster.error_cluster_hash)}
              aria-expanded={expanded}
              className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-sunken"
            >
              <ChevronRight size={16} className={`mt-0.5 shrink-0 text-ink-3 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
              <span className="tabular mt-px shrink-0 rounded-md bg-failed/12 px-1.5 text-sm font-semibold text-ink" title={`${cluster.count} tests`}>
                {cluster.count}×
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[13px] text-ink">{cluster.signature}</span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {cluster.browser_projects.map((project) => (
                    <span key={project} className="rounded border border-line px-1.5 text-[11px] text-ink-2">
                      {project}
                    </span>
                  ))}
                </span>
              </span>
            </button>
            {expanded && (
              <div className="space-y-3 px-4 pb-4 pl-11">
                <Ansi text={cluster.message} className="max-h-48 overflow-auto rounded-md bg-sunken p-3 font-mono text-xs whitespace-pre-wrap text-ink" />
                <ul className="space-y-1">
                  {cluster.tests.map((test) => (
                    <li key={test.execution_id}>
                      <button
                        type="button"
                        onClick={() => onOpen(test.execution_id)}
                        className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-sunken"
                      >
                        <StatusIcon status={test.status} size={14} />
                        <span className="truncate text-ink">{test.title}</span>
                        <span className="ml-auto shrink-0 text-xs text-ink-3">
                          {test.browser_project} · {test.file_path}:{test.line}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-2">
                  <CopyButton text={cluster.retry_command} label="Copy retry command" />
                  <code className="truncate text-xs text-ink-3">{cluster.retry_command.split('\n')[0]}</code>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
