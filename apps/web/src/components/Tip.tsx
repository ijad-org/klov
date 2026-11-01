import type { CSSProperties, ReactNode } from 'react';

/** CSS-only tooltip shown on hover and keyboard focus. Content is rendered as React text. */
export function Tip({
  content,
  children,
  className = '',
  style,
  align = 'center',
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  align?: 'center' | 'start' | 'end';
}) {
  const position = align === 'start' ? 'left-0' : align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2';
  return (
    <span className={`group/tip relative inline-flex ${className}`} style={style}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute bottom-full z-40 mb-2 w-max max-w-72 rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs text-ink opacity-0 shadow-lg transition-opacity group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 ${position}`}
      >
        {content}
      </span>
    </span>
  );
}
