import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      window.prompt('Copy to clipboard:', text);
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className={`inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-sunken ${className}`}
      title={text}
    >
      {copied ? <Check size={14} className="text-passed" aria-hidden /> : <Copy size={14} aria-hidden />}
      {copied ? 'Copied' : label}
    </button>
  );
}
