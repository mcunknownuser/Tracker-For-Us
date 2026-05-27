// =============================================================================
//  Select.tsx
//  Custom-styled dropdown that matches the editorial dark theme.
//  Replaces native <select> elements — those inherit OS chrome that looks
//  wrong against the dark UI.
//
//  Supports an optional `detail` per option, rendered as a tiny muted label
//  to the right of the main label (e.g. "Chatter" + "commission").
// =============================================================================

import { useEffect, useRef, useState } from 'react';

export type SelectOption = {
  value: string;
  label: string;
  detail?: string;
};

type SelectProps = {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
};

export function Select({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  // 'down' = panel opens below the trigger (default), 'up' = above.
  // Computed on open based on available viewport space.
  const [direction, setDirection] = useState<'down' | 'up'>('down');
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = options.find((o) => o.value === value);

  // Decide flip direction the moment the user clicks the trigger.
  function handleToggle() {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      // ~280px is roughly the dropdown's max height (max-h-64 plus some padding).
      const PANEL_MAX = 280;
      setDirection(spaceBelow < PANEL_MAX && spaceAbove > spaceBelow ? 'up' : 'down');
    }
    setOpen(true);
  }

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        id={id}
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        className={
          'flex w-full items-center justify-between border bg-neutral-950 px-3.5 py-3 text-sm transition-colors ' +
          'focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ' +
          (open
            ? 'border-neutral-500 text-neutral-100'
            : 'border-neutral-800 text-neutral-100 hover:border-neutral-700')
        }
      >
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="truncate">
            {selected?.label ?? (
              <span className="text-neutral-600">{placeholder ?? 'Select…'}</span>
            )}
          </span>
          {selected?.detail && (
            <span className="shrink-0 text-[9px] uppercase tracking-widest text-neutral-600">
              {selected.detail}
            </span>
          )}
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <div
          className={
            'absolute left-0 right-0 z-20 max-h-64 overflow-y-auto border border-neutral-800 bg-neutral-950 shadow-2xl ' +
            (direction === 'up' ? 'bottom-full mb-1' : 'top-full mt-1')
          }
        >
          {options.length === 0 ? (
            <div className="px-3.5 py-3 text-xs text-neutral-600">No options.</div>
          ) : (
            options.map((opt) => {
              const isSelected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={
                    'flex w-full items-baseline justify-between px-3.5 py-2.5 text-left text-sm transition-colors ' +
                    (isSelected
                      ? 'bg-neutral-900 text-neutral-50'
                      : 'text-neutral-200 hover:bg-neutral-900')
                  }
                >
                  <span className="truncate">{opt.label}</span>
                  {opt.detail && (
                    <span className="ml-3 shrink-0 text-[9px] uppercase tracking-widest text-neutral-600">
                      {opt.detail}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={
        'ml-2 shrink-0 text-neutral-500 transition-transform ' +
        (open ? 'rotate-180' : '')
      }
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
