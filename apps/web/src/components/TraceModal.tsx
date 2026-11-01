import { ExternalLink, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

/** Playwright's own trace viewer, served by the dashboard, opened on a pre-signed trace URL. */
export function traceViewerUrl(traceUrl: string): string {
  return `/trace-viewer/index.html?trace=${encodeURIComponent(traceUrl)}`;
}

export function TraceModal({ traceUrl, title, onClose }: { traceUrl: string; title: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const src = traceViewerUrl(traceUrl);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-page" role="dialog" aria-modal="true" aria-label={`Trace: ${title}`}>
      <div className="flex h-12 items-center gap-3 border-b border-line bg-surface px-4">
        <span className="truncate text-sm font-medium text-ink">Trace · {title}</span>
        <a href={src} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
          <ExternalLink size={15} aria-hidden /> New tab
        </a>
        <button ref={closeRef} type="button" onClick={onClose} className="rounded-md p-1.5 text-ink-2 hover:bg-sunken hover:text-ink" aria-label="Close trace">
          <X size={18} />
        </button>
      </div>
      <iframe title={`Trace viewer for ${title}`} src={src} className="w-full flex-1 border-0 bg-white" />
    </div>
  );
}
