import type { ReactNode } from 'react';

const COLORS: Record<number, string> = {
  30: 'ansi-gray', 31: 'ansi-red', 32: 'ansi-green', 33: 'ansi-yellow', 34: 'ansi-blue', 35: 'ansi-magenta', 36: 'ansi-cyan',
  90: 'ansi-gray', 91: 'ansi-red', 92: 'ansi-green', 93: 'ansi-yellow', 94: 'ansi-blue', 95: 'ansi-magenta', 96: 'ansi-cyan',
};

export interface AnsiSegment {
  text: string;
  classes: string[];
}

// SGR color sequences are rendered; every other escape sequence is dropped.
const ESCAPE = /\u001b\[([0-9;]*)([A-Za-z])/g;

export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let color: string | undefined;
  let bold = false;
  let dim = false;
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const classes = [color, bold ? 'ansi-bold' : undefined, dim ? 'ansi-dim' : undefined].filter((c): c is string => !!c);
    segments.push({ text, classes });
  };
  for (const match of input.matchAll(ESCAPE)) {
    push(input.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[2] !== 'm') continue;
    const codes = match[1] === '' ? [0] : match[1].split(';').map(Number);
    for (const code of codes) {
      if (code === 0) [color, bold, dim] = [undefined, false, false];
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) [bold, dim] = [false, false];
      else if (code === 39 || code === 37 || code === 97) color = undefined;
      else if (COLORS[code]) color = COLORS[code];
    }
  }
  push(input.slice(last));
  return segments;
}

export function stripAnsi(input: string): string {
  return input.replace(ESCAPE, '');
}

/** Renders Playwright's colored output safely (text nodes only, no HTML injection). */
export function Ansi({ text, className }: { text: string; className?: string }): ReactNode {
  return (
    <pre className={className}>
      {parseAnsi(text).map((segment, index) =>
        segment.classes.length ? (
          <span key={index} className={segment.classes.join(' ')}>
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </pre>
  );
}
