// =============================================================================
//  ConfirmContainer.tsx
//  Renders the editorial-styled confirm dialog when something calls confirm().
//  Mounted once at the root, next to <ToastContainer />.
// =============================================================================

import { useEffect, useState } from 'react';
import { subscribeToConfirm, type ConfirmEvent } from '../lib/confirm';

export function ConfirmContainer() {
  const [active, setActive] = useState<ConfirmEvent | null>(null);

  useEffect(() => {
    return subscribeToConfirm((event) => {
      // Only one confirm at a time. If a second comes in while one's open,
      // immediately resolve the first as cancel.
      setActive((prev) => {
        if (prev) prev.resolve(false);
        return event;
      });
    });
  }, []);

  // Close on Escape; lock page scroll while open.
  useEffect(() => {
    if (!active) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolveWith(false);
      if (e.key === 'Enter') resolveWith(true);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function resolveWith(value: boolean) {
    if (!active) return;
    active.resolve(value);
    setActive(null);
  }

  if (!active) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={() => resolveWith(false)}
      />

      {/* Dialog */}
      <div className="relative z-10 w-full max-w-md border border-neutral-800 bg-neutral-950 shadow-2xl">
        <div className="px-7 pt-7 pb-2">
          <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-50">
            {active.title}
          </h2>
          {active.message && (
            <p className="mt-3 text-sm leading-relaxed text-neutral-400">
              {active.message}
            </p>
          )}
        </div>

        <div className="mt-6 flex divide-x divide-neutral-800 border border-neutral-800">
          <button
            type="button"
            onClick={() => resolveWith(false)}
            className="flex-1 bg-neutral-950 px-4 py-4 text-[11px] font-medium uppercase tracking-widest text-neutral-300 transition-colors hover:bg-neutral-900 hover:text-neutral-100"
          >
            {active.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => resolveWith(true)}
            className={
              'flex-1 px-4 py-4 text-[11px] font-medium uppercase tracking-widest transition-colors ' +
              (active.destructive
                ? 'bg-red-950 text-red-100 hover:bg-red-900'
                : 'bg-neutral-50 text-neutral-950 hover:bg-neutral-300')
            }
          >
            {active.confirmLabel ?? (active.destructive ? 'Delete' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
