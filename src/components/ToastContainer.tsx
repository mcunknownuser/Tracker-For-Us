// =============================================================================
//  ToastContainer.tsx
//  Renders queued toast notifications in the bottom-right of the screen.
//  Each toast auto-dismisses after a few seconds. Toasts with an action
//  button (e.g. "Undo") stay around longer and render the action inline.
// =============================================================================

import { useEffect, useState } from 'react';
import { subscribeToToasts, type ToastEvent } from '../lib/toast';

const DEFAULT_DISPLAY_MS = 4000;

export function ToastContainer() {
  const [items, setItems] = useState<ToastEvent[]>([]);

  useEffect(() => {
    return subscribeToToasts((event) => {
      setItems((prev) => [...prev, event]);
      const ttl = event.durationMs ?? DEFAULT_DISPLAY_MS;
      setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== event.id));
      }, ttl);
    });
  }, []);

  if (items.length === 0) return null;

  const dismiss = (id: string) => setItems((prev) => prev.filter((t) => t.id !== id));

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={
            'pointer-events-auto flex min-w-[260px] max-w-[420px] items-center gap-3 border px-4 py-3 text-sm shadow-2xl backdrop-blur ' +
            (t.kind === 'error'
              ? 'border-red-900/60 bg-neutral-900 text-red-200'
              : t.kind === 'success'
                ? 'border-neutral-700 bg-neutral-900 text-neutral-100'
                : 'border-neutral-800 bg-neutral-900 text-neutral-300')
          }
        >
          <span className="flex-1">{t.message}</span>
          {t.actionLabel && t.onAction && (
            <button
              type="button"
              onClick={() => {
                t.onAction!();
                dismiss(t.id);
              }}
              className="shrink-0 border border-neutral-700 px-2.5 py-1 text-[10px] font-medium uppercase tracking-widest text-neutral-100 transition-colors hover:border-neutral-400 hover:bg-neutral-800"
            >
              {t.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
