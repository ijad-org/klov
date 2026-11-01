import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, FileCode2, FolderClosed, Layers, Search } from 'lucide-react';
import { useDeferredValue, useMemo, useRef, useState } from 'react';

import type { TestRow } from '../generated/TestRow';
import { useNow } from '../hooks/useNow';
import { formatDuration } from '../lib/format';
import { matchesQuery, parseQuery } from '../lib/search';
import { type StatusGroup, StatusIcon, statusGroup } from '../lib/status';
import { buildTree, flattenTree, type GroupBy, type TreeGroup, type TreeItem } from '../lib/tree';
import { DurationDelta, SparklineHistory } from './SparklineHistory';

const ROW_HEIGHT = 36;
const FILTERS: { key: StatusGroup | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'failed', label: 'Failed' },
  { key: 'flaky', label: 'Flaky' },
  { key: 'passed', label: 'Passed' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'running', label: 'Running' },
];

const LEVEL_ICONS: Record<string, typeof FileCode2> = { file: FileCode2, describe: FolderClosed, epic: Layers, feature: Layers, story: Layers };

/**
 * Every test of the launch, grouped by file/describe or by epic → feature → story.
 * Virtualized, so launches with tens of thousands of tests stay smooth while rows
 * update live.
 */
export function LiveTestTree({ rows, selected, onSelect }: { rows: TestRow[]; selected?: string; onSelect: (executionId: string) => void }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StatusGroup | 'all'>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('suite');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const deferredSearch = useDeferredValue(search);
  const hasRunning = rows.some((r) => r.status === 'running');
  const now = useNow(1_000, hasRunning);

  const counts = useMemo(() => {
    const result: Record<StatusGroup | 'all', number> = { all: rows.length, failed: 0, flaky: 0, passed: 0, skipped: 0, running: 0 };
    for (const row of rows) result[statusGroup(row.status)]++;
    return result;
  }, [rows]);

  const filtered = useMemo(() => {
    const query = parseQuery(deferredSearch);
    return rows.filter((row) => (filter === 'all' || statusGroup(row.status) === filter) && matchesQuery(row, query));
  }, [rows, filter, deferredSearch]);

  const tree = useMemo(() => buildTree(filtered, groupBy), [filtered, groupBy]);
  const items = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allGroupIds = () => {
    const ids: string[] = [];
    const visit = (list: TreeItem[]) => list.forEach((i) => i.kind === 'group' && (ids.push(i.id), visit(i.children)));
    visit(tree);
    return ids;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <label className="flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2 focus-within:border-accent">
          <Search size={16} className="text-ink-3" aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter: checkout  status:failed  @smoke  project:chromium  owner:…"
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
            aria-label="Filter tests"
          />
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.filter((f) => f.key === 'all' || counts[f.key] > 0 || f.key === filter).map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                filter === f.key ? 'border-accent bg-accent-wash text-ink' : 'border-line text-ink-2 hover:bg-sunken'
              }`}
            >
              {f.key !== 'all' && <StatusIcon status={f.key} size={13} />}
              {f.label}
              <span className="tabular text-ink-3">{counts[f.key]}</span>
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1">
            <div className="flex rounded-lg border border-line p-0.5 text-xs" role="group" aria-label="Group tests by">
              {(['suite', 'behavior'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setGroupBy(mode)}
                  aria-pressed={groupBy === mode}
                  className={`rounded-md px-2 py-0.5 ${groupBy === mode ? 'bg-sunken font-medium text-ink' : 'text-ink-2'}`}
                >
                  {mode === 'suite' ? 'Suites' : 'Behaviors'}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setCollapsed(new Set())} className="rounded px-1.5 py-0.5 text-xs text-ink-2 hover:bg-sunken">
              Expand
            </button>
            <button type="button" onClick={() => setCollapsed(new Set(allGroupIds()))} className="rounded px-1.5 py-0.5 text-xs text-ink-2 hover:bg-sunken">
              Collapse
            </button>
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" role="tree" aria-label="Tests">
        {items.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-ink-2">{rows.length === 0 ? 'Tests appear here as they start.' : 'No tests match this filter.'}</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtual) => {
              const item = items[virtual.index];
              return (
                <div key={item.id} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${virtual.start}px)` }}>
                  {item.kind === 'group' ? (
                    <GroupRow group={item} collapsed={collapsed.has(item.id)} onToggle={() => toggle(item.id)} />
                  ) : (
                    <TestLine row={item.row} depth={item.depth} selected={item.row.execution_id === selected} now={now} onSelect={onSelect} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupRow({ group, collapsed, onToggle }: { group: TreeGroup; collapsed: boolean; onToggle: () => void }) {
  const Icon = LEVEL_ICONS[group.level] ?? FolderClosed;
  return (
    <button
      type="button"
      role="treeitem"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="flex h-full w-full items-center gap-2 pr-3 text-left text-sm hover:bg-sunken"
      style={{ paddingLeft: 12 + group.depth * 16 }}
    >
      <ChevronRight size={14} className={`shrink-0 text-ink-3 transition-transform ${collapsed ? '' : 'rotate-90'}`} aria-hidden />
      <StatusIcon status={group.status} size={14} />
      <Icon size={14} className="shrink-0 text-ink-3" aria-hidden />
      <span className={`truncate ${group.level === 'file' ? 'font-mono text-[13px]' : 'font-medium'} text-ink`}>{group.label}</span>
      <span className="ml-auto shrink-0 text-xs text-ink-3 tabular">
        {group.failed > 0 && <span className="font-semibold text-ink">{group.failed} failed · </span>}
        {group.total} {group.total === 1 ? 'test' : 'tests'}
      </span>
    </button>
  );
}

function TestLine({ row, depth, selected, now, onSelect }: { row: TestRow; depth: number; selected: boolean; now: number; onSelect: (id: string) => void }) {
  const running = row.status === 'running';
  // The shared clock ticks once a second, so it can lag a test that just started.
  const duration = running ? Math.max(0, now - Date.parse(row.started_at)) : row.duration_ms;
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={selected}
      onClick={() => onSelect(row.execution_id)}
      className={`flex h-full w-full items-center gap-2 pr-3 text-left text-sm ${selected ? 'bg-accent-wash' : 'hover:bg-sunken'}`}
      style={{ paddingLeft: 12 + depth * 16 + 20 }}
      title={row.error_message ? row.error_message.split('\n')[0] : row.title}
    >
      <StatusIcon status={row.status} size={15} />
      <span className="min-w-0 truncate text-ink">{row.title}</span>
      {row.browser_project && (
        <span className="hidden shrink-0 rounded border border-line px-1.5 text-[11px] text-ink-2 sm:inline">{row.browser_project}</span>
      )}
      {row.retry_attempt > 0 && (
        <span className="shrink-0 rounded bg-sunken px-1.5 text-[11px] text-ink-2">retry {row.retry_attempt}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <span className="hidden md:inline-flex">
          <SparklineHistory history={row.history} />
        </span>
        {!running && <DurationDelta duration={row.duration_ms} average={row.avg_duration_ms} />}
        <span className="tabular w-14 text-right text-xs text-ink-2">{formatDuration(duration)}</span>
      </span>
    </button>
  );
}
