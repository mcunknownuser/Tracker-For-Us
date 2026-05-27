// =============================================================================
//  DatePicker.tsx
//  Custom date picker matching the editorial dark theme. Replaces the native
//  <input type="date"> which renders the OS calendar UI.
//
//  Stores and emits YYYY-MM-DD strings.
// =============================================================================

import { useEffect, useRef, useState } from 'react';

type DatePickerProps = {
  id?: string;
  value: string; // YYYY-MM-DD
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
};

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export function DatePicker({ id, value, onChange, placeholder, disabled }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Month currently shown in the panel. Defaults to the selected month, or today.
  const initialAnchor = parseDate(value) ?? new Date();
  const [anchor, setAnchor] = useState<Date>(
    new Date(initialAnchor.getFullYear(), initialAnchor.getMonth(), 1),
  );

  // Reset anchor when opening so it shows the selected month.
  useEffect(() => {
    if (open) {
      const sel = parseDate(value);
      if (sel) setAnchor(new Date(sel.getFullYear(), sel.getMonth(), 1));
    }
  }, [open, value]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const display = value ? formatDisplay(parseDate(value)!) : '';

  return (
    <div ref={ref} className="relative">
      <button
        id={id}
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className={
          'flex w-full items-center justify-between border bg-neutral-950 px-3.5 py-3 text-sm transition-colors ' +
          'focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ' +
          (open
            ? 'border-neutral-500 text-neutral-100'
            : 'border-neutral-800 text-neutral-100 hover:border-neutral-700')
        }
      >
        <span className={display ? '' : 'text-neutral-600'}>
          {display || placeholder || 'Pick a date'}
        </span>
        <CalendarIcon />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 border border-neutral-800 bg-neutral-950 p-4 shadow-2xl">
          <MonthHeader
            anchor={anchor}
            onPrev={() => setAnchor(prevMonth(anchor))}
            onNext={() => setAnchor(nextMonth(anchor))}
            onToday={() => {
              const today = new Date();
              setAnchor(new Date(today.getFullYear(), today.getMonth(), 1));
            }}
          />
          <DayGrid
            anchor={anchor}
            selected={parseDate(value)}
            onPick={(d) => {
              onChange(formatISO(d));
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
//  InlineCalendar — calendar grid with no trigger, used by DatePicker and
//  other components that want to show a calendar directly (no double-click).
// -----------------------------------------------------------------------------
export function InlineCalendar({
  value,
  onChange,
}: {
  value: string; // YYYY-MM-DD
  onChange: (v: string) => void;
}) {
  const initialAnchor = parseDate(value) ?? new Date();
  const [anchor, setAnchor] = useState<Date>(
    new Date(initialAnchor.getFullYear(), initialAnchor.getMonth(), 1),
  );
  return (
    <div>
      <MonthHeader
        anchor={anchor}
        onPrev={() => setAnchor(prevMonth(anchor))}
        onNext={() => setAnchor(nextMonth(anchor))}
        onToday={() => {
          const today = new Date();
          setAnchor(new Date(today.getFullYear(), today.getMonth(), 1));
        }}
      />
      <DayGrid
        anchor={anchor}
        selected={parseDate(value)}
        onPick={(d) => onChange(formatISO(d))}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
//  Month header — title + prev/next + today
// -----------------------------------------------------------------------------
function MonthHeader({
  anchor,
  onPrev,
  onNext,
  onToday,
}: {
  anchor: Date;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  const label = anchor.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return (
    <div className="mb-4 flex items-center justify-between">
      <button
        type="button"
        onClick={onPrev}
        className="border border-neutral-800 px-2 py-1 text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
        aria-label="Previous month"
      >
        <ChevronLeft />
      </button>
      <button
        type="button"
        onClick={onToday}
        className="font-serif text-base font-semibold tracking-tight text-neutral-100 hover:text-neutral-300"
        title="Jump to today"
      >
        {label}
      </button>
      <button
        type="button"
        onClick={onNext}
        className="border border-neutral-800 px-2 py-1 text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
        aria-label="Next month"
      >
        <ChevronRight />
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
//  Day grid — Sunday-first, 6 rows of 7 days.
// -----------------------------------------------------------------------------
function DayGrid({
  anchor,
  selected,
  onPick,
}: {
  anchor: Date;
  selected: Date | null;
  onPick: (d: Date) => void;
}) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const lastDayInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  const startDow = first.getDay(); // 0 = Sunday

  // Build a 6x7 grid. Days from previous and next month fill the edges.
  const days: Date[] = [];
  for (let i = 0; i < startDow; i++) {
    days.push(new Date(anchor.getFullYear(), anchor.getMonth(), -startDow + i + 1));
  }
  for (let d = 1; d <= lastDayInMonth; d++) {
    days.push(new Date(anchor.getFullYear(), anchor.getMonth(), d));
  }
  while (days.length < 42) {
    const last = days[days.length - 1]!;
    days.push(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1));
  }

  const today = stripTime(new Date());
  const selDay = selected ? stripTime(selected) : null;
  const currentMonth = anchor.getMonth();

  return (
    <div>
      {/* Day-of-week header */}
      <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-[10px] uppercase tracking-widest text-neutral-600">
        {DAY_LABELS.map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
      </div>
      {/* Day cells */}
      <div className="grid grid-cols-7 gap-0.5">
        {days.map((d, i) => {
          const inMonth = d.getMonth() === currentMonth;
          const isToday = stripTime(d).getTime() === today.getTime();
          const isSelected = selDay && stripTime(d).getTime() === selDay.getTime();
          return (
            <button
              key={i}
              type="button"
              onClick={() => onPick(d)}
              className={
                'h-9 text-sm transition-colors ' +
                (isSelected
                  ? 'bg-neutral-50 text-neutral-950 font-semibold'
                  : isToday
                    ? 'border border-neutral-700 text-neutral-100 hover:bg-neutral-900'
                    : inMonth
                      ? 'text-neutral-200 hover:bg-neutral-900'
                      : 'text-neutral-700 hover:bg-neutral-900')
              }
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
//  Helpers
// -----------------------------------------------------------------------------
function parseDate(s: string): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function formatISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDisplay(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function prevMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() - 1, 1);
}
function nextMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}
function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// -----------------------------------------------------------------------------
//  Icons
// -----------------------------------------------------------------------------
function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-500" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  );
}
function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  );
}
function ChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  );
}
