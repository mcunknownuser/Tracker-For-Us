// =============================================================================
//  parts.tsx
//  The small pieces every section renderer shares: the section shell, the
//  figure cell, target formatting, and footnote collection.
//
//  The rule that matters here is the missing-value rule. A ComputedValue with
//  `raw: null` is "we could not work this out", which is a different statement
//  from zero. It renders as a grey em-dash with its `note` attached, never as
//  a number and never as a red badge — an employee whose hours were not logged
//  must not read as an employee who did nothing.
// =============================================================================

import type { ReactNode } from 'react';
import type { ComputedRow, ComputedValue, Metric, MetricFormat } from '../../lib/reports/types';

// Markers the engine may use for "nothing here". Anything else in `formatted`
// is real text (a passthrough string column has raw: null but a real label).
const MISSING_MARKERS = new Set(['', '-', '–', '—', 'n/a', 'na']);

export function isMissing(value?: ComputedValue): boolean {
  if (!value) return true;
  return value.raw === null && MISSING_MARKERS.has(value.formatted.trim().toLowerCase());
}

export type Tone = 'pass' | 'near' | 'fail';

// The engine decides pass/fail; "near" is a presentation tier only — a miss
// within 10% of the target reads amber rather than red so the eye can tell
// "nearly there" from "not close". It never turns a fail into a pass.
export function targetTone(value: ComputedValue, target?: Metric['target']): Tone | undefined {
  if (value.meetsTarget === undefined) return undefined;
  if (value.meetsTarget) return 'pass';
  if (target && value.raw !== null && target.value !== 0) {
    const ratio = value.raw / target.value;
    const near = target.comparator === '>=' ? ratio >= 0.9 && ratio < 1 : ratio > 1 && ratio <= 1.1;
    if (near) return 'near';
  }
  return 'fail';
}

const bare = (v: number, format: MetricFormat): string => {
  const n = v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (format === 'currency') return `$${n}`;
  if (format === 'percent') return `${n}%`;
  if (format === 'integer') return Math.round(v).toLocaleString('en-US');
  return n;
};

export function formatTarget(metric: Metric): string | null {
  const t = metric.target;
  if (!t) return null;
  return `${t.comparator === '>=' ? '≥' : '≤'} ${bare(t.value, metric.format)}`;
}

// ---- Footnotes -------------------------------------------------------------

export type NoteIndex = {
  list: string[];
  mark: (value?: ComputedValue) => number | undefined;
};

// Notes are numbered in reading order and de-duplicated, so "no clocked hours
// this period" appears once at the foot of the section however many cells it
// explains.
export function collectNotes(values: (ComputedValue | undefined)[]): NoteIndex {
  const list: string[] = [];
  for (const v of values) {
    if (v?.note && !list.includes(v.note)) list.push(v.note);
  }
  return {
    list,
    mark: (v) => (v?.note ? list.indexOf(v.note) + 1 || undefined : undefined),
  };
}

// Whether a row-shaped section should give up `break-inside: avoid` in print.
//
// Keeping a card whole is what stops its heading stranding at the foot of a
// page with the table overleaf — Chrome's `break-after: avoid` on the heading
// alone is not reliable. But a card taller than a page cannot be kept whole,
// and forcing it only pushes the break somewhere worse. So: keep short
// sections together, let long ones flow and split between rows.
export function flowsAcrossPages(rowCount: number): boolean {
  return rowCount > 18;
}

export function rowValues(
  rows: ComputedRow[] | undefined,
  columns: string[],
): (ComputedValue | undefined)[] {
  const out: (ComputedValue | undefined)[] = [];
  for (const row of rows ?? []) {
    for (const c of columns) out.push(row.values[c]);
  }
  return out;
}

// ---- Cells -----------------------------------------------------------------

export function Figure({
  value,
  tone,
  mark,
}: {
  value?: ComputedValue;
  tone?: Tone;
  mark?: number;
}) {
  const missing = isMissing(value);
  const className = missing ? 'rpt-missing' : tone ? `rpt-badge rpt-badge--${tone}` : undefined;
  return (
    <span className={className} title={value?.note || undefined}>
      {missing ? '—' : value?.formatted}
      {mark ? <sup className="rpt-sup">{mark}</sup> : null}
    </span>
  );
}

export function Paragraphs({ text, className }: { text: string; className?: string }) {
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return null;
  return (
    <div className={className}>
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}

// ---- Section shell ---------------------------------------------------------

export function SectionShell({
  title,
  commentary,
  notes,
  flow,
  aside,
  children,
}: {
  title: string;
  commentary?: string;
  notes?: string[];
  // Long, row-shaped sections must be allowed to break across pages.
  flow?: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className={`rpt-card ${flow ? 'rpt-flow' : 'rpt-avoid-break'}`}>
        <div className="rpt-section-head mb-5">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="rpt-h2">{title}</h2>
            {aside}
          </div>
          <hr className="rpt-h2-rule mt-2.5" />
        </div>
        {commentary ? <Paragraphs text={commentary} className="rpt-prose mb-5" /> : null}
        {/* The planner decides how many columns a section has, so a wide
            scorecard is normal, not a bug. On screen it scrolls inside the
            card instead of bleeding past the edge; in print the wrapper is
            neutralised and dense type takes over (see report.css). */}
        <div className="rpt-scroll">{children}</div>
        {notes && notes.length > 0 ? (
          <ol className="rpt-footnotes mt-5 pt-3">
            {notes.map((n, i) => (
              <li key={i}>
                <span className="rpt-sup">{i + 1}</span> {n}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

// A section that failed to compute. Shown in place of the section so the
// failure is visible in the printed report rather than a silent hole — the
// rest of the document still renders.
export function SectionError({ title, error }: { title: string; error: string }) {
  return (
    <section className="mb-8">
      <div className="rpt-error rpt-avoid-break">
        <div className="rpt-label" style={{ color: 'inherit' }}>
          Section could not be computed
        </div>
        <div className="mt-1.5 font-semibold">{title}</div>
        <p className="mt-1">{error}</p>
      </div>
    </section>
  );
}
