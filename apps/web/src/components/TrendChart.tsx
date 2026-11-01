import { useLayoutEffect, useRef, useState } from 'react';

import type { TrendPoint } from '../generated/TrendPoint';
import { formatDateTime, formatDuration } from '../lib/format';

/** Bottom to top: failures sit on the baseline so they compare across launches. */
const SERIES = [
  { key: 'failed', label: 'Failed', color: 'var(--status-failed)' },
  { key: 'flaky', label: 'Flaky', color: 'var(--status-flaky)' },
  { key: 'passed', label: 'Passed', color: 'var(--status-passed)' },
  { key: 'skipped', label: 'Skipped', color: 'var(--status-skipped)' },
] as const;

const HEIGHT = 220;
const MARGIN = { top: 8, right: 8, bottom: 24, left: 36 };
const GAP = 2;

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const multiple of [1, 2, 2.5, 4, 5, 10]) if (multiple * magnitude >= value) return multiple * magnitude;
  return 10 * magnitude;
}

function compact(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K` : String(value);
}

/** Path for a rectangle with rounded top corners (data end) and a square base. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${y + h}Z`;
}

/** Stacked result counts per launch, oldest left. Click a column to open the launch. */
export function TrendChart({ points, onSelect }: { points: TrendPoint[]; onSelect: (launchId: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  if (points.length === 0) return <p className="px-4 py-10 text-center text-sm text-ink-2">No launches yet.</p>;

  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const max = niceMax(Math.max(...points.map((p) => p.passed + p.failed + p.flaky + p.skipped), 1));
  const band = innerWidth / points.length;
  const barWidth = Math.max(4, Math.min(24, band * 0.6));
  const y = (value: number) => (value / max) * innerHeight;
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const hovered = hover !== null ? points[hover] : null;

  return (
    <div ref={ref} className="relative">
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-label="Legend">
        {SERIES.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
      <svg width={width} height={HEIGHT} role="img" aria-label={`Test results for the last ${points.length} launches`}>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {[0, 0.5, 1].map((t) => (
            <g key={t} transform={`translate(0,${innerHeight - t * innerHeight})`}>
              <line x1={0} x2={innerWidth} stroke={t === 0 ? 'var(--baseline)' : 'var(--grid)'} strokeWidth={1} />
              <text x={-8} dy="0.32em" textAnchor="end" className="tabular fill-ink-3 text-[11px]">
                {compact(Math.round(max * t))}
              </text>
            </g>
          ))}
          {points.map((point, index) => {
            const x = index * band + (band - barWidth) / 2;
            const present = SERIES.filter((series) => point[series.key] > 0);
            // Segments stack upward from the baseline with a 2px surface gap between them.
            let cursor = innerHeight;
            const segments = present.map((series, i) => {
              const full = y(point[series.key]);
              const top = cursor - full;
              cursor = top;
              const height = Math.max(1, full - (i > 0 ? GAP : 0));
              return i === present.length - 1 ? (
                <path key={series.key} d={topRounded(x, top, barWidth, height, 4)} fill={series.color} />
              ) : (
                <rect key={series.key} x={x} y={top} width={barWidth} height={height} fill={series.color} />
              );
            });
            return (
              <g key={point.launch_id} opacity={hover === null || hover === index ? 1 : 0.55}>
                {segments}
                {point.status === 'running' && (
                  <text x={x + barWidth / 2} y={cursor - 4} textAnchor="middle" className="fill-ink-3 text-[10px]">
                    live
                  </text>
                )}
                {(index % labelEvery === 0 || index === points.length - 1) && (
                  <text x={index * band + band / 2} y={innerHeight + 16} textAnchor="middle" className="tabular fill-ink-3 text-[11px]">
                    {point.build_number ? `#${point.build_number}` : index + 1}
                  </text>
                )}
                <rect
                  x={index * band}
                  y={0}
                  width={band}
                  height={innerHeight}
                  fill="transparent"
                  className="cursor-pointer outline-none"
                  tabIndex={0}
                  role="button"
                  aria-label={`Launch ${point.build_number ?? index + 1}: ${point.failed} failed, ${point.flaky} flaky, ${point.passed} passed, ${point.skipped} skipped`}
                  onMouseEnter={() => setHover(index)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(index)}
                  onBlur={() => setHover(null)}
                  onClick={() => onSelect(point.launch_id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(point.launch_id)}
                />
              </g>
            );
          })}
        </g>
      </svg>
      {hovered && hover !== null && (
        <div
          className="pointer-events-none absolute top-6 z-10 w-48 rounded-lg border border-line bg-raised p-3 text-xs shadow-lg"
          style={{ left: Math.min(width - 200, Math.max(0, MARGIN.left + hover * band + band / 2 - 96)) }}
        >
          <p className="font-medium text-ink">
            {hovered.build_number ? `Build #${hovered.build_number}` : 'Launch'}
            {hovered.branch && <span className="font-normal text-ink-3"> · {hovered.branch}</span>}
          </p>
          <p className="mb-2 text-ink-3">{formatDateTime(hovered.started_at)}</p>
          {[...SERIES].reverse().map((s) => (
            <p key={s.key} className="flex items-center gap-2">
              <span className="h-0.5 w-3 rounded" style={{ background: s.color }} aria-hidden />
              <span className="tabular font-semibold text-ink">{hovered[s.key]}</span>
              <span className="text-ink-2">{s.label.toLowerCase()}</span>
            </p>
          ))}
          <p className="mt-2 text-ink-2">Duration {formatDuration(hovered.duration_ms)}</p>
        </div>
      )}
    </div>
  );
}
