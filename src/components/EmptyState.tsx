// =============================================================================
//  EmptyState.tsx
//  Replaces the previous bare "Nothing here yet" lines with a richer
//  block that guides the user toward the first action.
// =============================================================================

import type { ReactNode } from 'react';

type EmptyStateProps = {
  // Tiny eyebrow label at top (e.g. "No data yet").
  eyebrow?: string;
  title: string;
  message?: string;
  // Primary CTA (optional). Renders as a small editorial button.
  ctaLabel?: string;
  onCta?: () => void;
  // Secondary slot for an icon, illustration, or anything else.
  icon?: ReactNode;
  // Compact mode for inline panels (e.g. Outstanding list). Drops some
  // padding and font sizes so the block still fits inside a card.
  compact?: boolean;
};

export function EmptyState({
  eyebrow,
  title,
  message,
  ctaLabel,
  onCta,
  icon,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={
        'flex flex-col items-center justify-center border border-dashed border-neutral-800 bg-neutral-950 text-center ' +
        (compact ? 'px-4 py-8' : 'px-6 py-14')
      }
    >
      {icon && <div className="mb-4 text-neutral-600">{icon}</div>}
      {eyebrow && (
        <div className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-600">
          {eyebrow}
        </div>
      )}
      <h3
        className={
          'font-serif font-semibold tracking-tight text-neutral-100 ' +
          (compact ? 'text-base' : 'text-xl')
        }
      >
        {title}
      </h3>
      {message && (
        <p
          className={
            'mt-2 max-w-md text-neutral-500 ' +
            (compact ? 'text-xs' : 'text-sm')
          }
        >
          {message}
        </p>
      )}
      {ctaLabel && onCta && (
        <button
          type="button"
          onClick={onCta}
          className="mt-5 border border-neutral-700 bg-transparent px-4 py-2 text-[11px] font-medium uppercase tracking-widest text-neutral-100 transition-colors hover:border-neutral-400 hover:bg-neutral-900"
        >
          {ctaLabel}
        </button>
      )}
    </div>
  );
}
