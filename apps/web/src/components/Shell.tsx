import { Monitor, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { useTheme } from '../hooks/useTheme';

export interface Crumb {
  label: string;
  to?: string;
}

export function Shell({ crumbs = [], actions, children }: { crumbs?: Crumb[]; actions?: ReactNode; children: ReactNode }) {
  const { choice, cycle } = useTheme();
  const ThemeIcon = choice === 'dark' ? Moon : choice === 'light' ? Sun : Monitor;
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold text-ink">
            <img src="/favicon.svg" alt="" className="size-6" />
            KlovPlay
          </Link>
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm text-ink-2">
            {crumbs.map((crumb, index) => (
              <span key={index} className="flex min-w-0 items-center gap-2">
                <span className="text-ink-3">/</span>
                {crumb.to ? (
                  <Link to={crumb.to} className="truncate hover:text-ink">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="truncate text-ink">{crumb.label}</span>
                )}
              </span>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={cycle}
              className="rounded-md p-2 text-ink-2 hover:bg-sunken hover:text-ink"
              title={`Theme: ${choice} (click to change)`}
              aria-label={`Theme: ${choice}. Change theme`}
            >
              <ThemeIcon size={18} />
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6">{children}</main>
    </div>
  );
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="mt-2 text-sm text-ink-2">{children}</div>}
    </div>
  );
}
